import json
from pathlib import Path
import subprocess
import sys
import time
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, func

from backend import hooks, main, safety, safety_worker, judge
from backend.db import ROOT, SafetyEvaluation, SafetyAttempt, Event
from backend.tests.test_monitor import store, transcript
from backend.tests.test_hooks import connection, envelope
from backend.tests.test_safety import add_job
from scripts import gate_hook


@pytest.mark.parametrize("verdict,choice,exit_code", [("allow", None, 0), ("deny", None, 2), ("review", "approve", 0), ("review", "deny", 2), ("error", None, 2)])
def test_real_hook_waits_for_worker_then_returns(store, tmp_path, monkeypatch, verdict, choice, exit_code):
    monkeypatch.setenv("RELAY_HOOK_QUEUE", str(tmp_path / "queue"))
    monkeypatch.setattr(safety, "read_key", lambda: "sk-ant-test-only")
    path = tmp_path / "rollout.jsonl"; transcript(path, "codex_cli_rs")
    with store() as db:
        c = connection(db, tmp_path); c.gate_enabled = True; db.commit()
        queue = hooks.queue_path(c)
    queue.mkdir(parents=True); (queue / "enabled").touch(); (queue / "gate-enabled").touch()
    process = subprocess.Popen([sys.executable, str(ROOT / "scripts/gate_hook.py"), str(queue), "codex_cli", str(tmp_path)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        process.stdin.write(json.dumps(envelope(path)["payload"]).encode()); process.stdin.close()
        deadline = time.monotonic() + 8
        job = None
        while time.monotonic() < deadline:
            main.synchronize_hooks()
            with store() as db:
                job = db.scalar(select(SafetyEvaluation))
            if job:
                break
            time.sleep(.05)
        assert job and job.mode == "blocking" and job.status == "queued"
        assert process.poll() is None  # Native action has not been released.
        def evaluator(_job, _key):
            if verdict == "error":
                raise judge.JudgeError("Synthetic service failure.", diagnostics={"type": "test_failure"})
            return {"recommendation": verdict, "risk": "low", "reason": "Synthetic test", "evidence": [], "missing_context": [], "source": "judge"}, {}
        assert safety_worker.run_one(store, evaluator)
        if verdict == "review":
            main.synchronize_hooks()
            assert process.poll() is None
            with store() as db:
                saved = db.get(SafetyEvaluation, job.id)
                assert saved.status == "awaiting_review" and saved.decision is None
            client = TestClient(main.app, base_url="http://localhost")
            response = client.post(f"/api/safety/evaluations/{job.id}/review", json={"decision": choice, "input_hash": job.input_hash})
            assert response.status_code == 200
            assert response.json()["human_decision"] == choice
            assert client.post(f"/api/safety/evaluations/{job.id}/review", json={"decision": choice, "input_hash": job.input_hash}).status_code == 409
        while process.poll() is None and time.monotonic() < deadline:
            main.synchronize_hooks(); time.sleep(.05)
        assert process.wait(timeout=2) == exit_code
        assert process.stdout.read() == b""  # Never bypass native permissions with allow JSON.
        main.synchronize_hooks()
        with store() as db:
            saved = db.get(SafetyEvaluation, job.id)
            assert saved.returned_at and saved.gate["decision"] == ("pass" if verdict == "allow" or choice == "approve" else "error" if verdict == "error" else "deny")
            assert db.scalar(select(func.count()).select_from(SafetyAttempt)) == 1
    finally:
        if process.poll() is None:
            process.kill(); process.wait()


def test_expired_job_and_late_response_cannot_release(store, tmp_path):
    path = tmp_path / "rollout.jsonl"; transcript(path, "codex_cli_rs")
    with store() as db:
        c = connection(db, tmp_path)
        item = envelope(path); item["request"] = {"id": str(uuid4()), "deadline": safety.later(50)}
        hooks.ingest(db, c, item); db.commit()
    job = safety.claim(store)
    with store() as db:
        db.get(SafetyEvaluation, job.id).deadline = safety.later(-1); db.commit()
    assert not safety.finish(store, job, result={"recommendation": "allow"})
    with store() as db:
        assert db.get(SafetyEvaluation, job.id).decision == "expired"


def test_hook_rejects_wrong_request_and_times_out(tmp_path, monkeypatch):
    request = {"id": str(uuid4()), "deadline": safety.later(60)}
    replies = tmp_path / "replies"; replies.mkdir()
    reply = replies / (request["id"] + ".json")
    reply.write_text(json.dumps({"id": str(uuid4()), "input_hash": "exact", "deadline": request["deadline"], "decision": "pass"}))
    with pytest.raises(ValueError, match="Mismatched"):
        gate_hook.await_decision(tmp_path, request, "exact", time.monotonic())
    reply.unlink()
    monkeypatch.setattr(gate_hook, "WAIT_SECONDS", .01)
    assert gate_hook.await_decision(tmp_path, request, "exact", time.monotonic()) == "expired"
    assert json.loads((tmp_path / "receipts" / (request["id"] + ".json")).read_text())["decision"] == "expired"


def test_fresh_context_contains_user_request(store, tmp_path):
    job_id = add_job(store, tmp_path)
    with store() as db:
        context = db.get(SafetyEvaluation, job_id).snapshot
    assert any("Inspect the repository" in r["text"] for r in context["live_context"]["messages"])


def test_retry_is_advisory_and_chart_counts_actions_once(store, tmp_path):
    job_id = add_job(store, tmp_path)
    with store() as db:
        job = db.get(SafetyEvaluation, job_id); job.status = "failed"; job.error = "Historical schema error."
        event = db.get(Event, job.event_id)
        session_id = event.session_id
        db.commit()
    client = TestClient(main.app, base_url="http://localhost")
    retry = client.post(f"/api/safety/evaluations/{job_id}/retry")
    assert retry.status_code == 201 and retry.json()["mode"] == "shadow" and retry.json()["deadline"] is None
    data = client.get(f"/api/metrics?session_ids={session_id}").json()
    assert data["actions"] == 1 and data["safety"]["pending"] == 1
    assert sum(data["safety"][k] for k in ("pending", "released", "denied", "error", "shadow", "unassessed")) == 1
    assert sum(row["safety"].get("pending", 0) for row in data["series"]) == 1
    assert client.get("/api/metrics?session_ids=does-not-exist").json()["safety"]["pending"] == 0
    assert client.get(f"/api/safety/actions?session_ids={session_id}&safety_state=pending").json()["total"] == 1
    assert client.get(f"/api/safety/actions?session_ids={session_id}&safety_state=denied").json()["total"] == 0


def test_strict_schema_and_diagnostics_do_not_disclose_input(monkeypatch):
    from types import SimpleNamespace
    import io
    job = SimpleNamespace(model="claude-haiku-4-5-20251001", snapshot={"action_truncated": False}, rules={})
    body = judge.request_body(job)
    assert body["tools"][0]["strict"] is True
    assert "maxLength" not in json.dumps(body["tools"][0]["input_schema"])
    class Opener:
        def open(self, *_args, **_kwargs):
            return io.BytesIO(json.dumps({"id": "test", "stop_reason": "tool_use", "content": [{"type": "tool_use", "name": "submit_verdict", "input": {"recommendation": "secret-invalid"}}]}).encode())
    monkeypatch.setattr(judge.urllib.request, "build_opener", lambda *_: Opener())
    with pytest.raises(judge.JudgeError) as error:
        judge.evaluate(job, "sk-ant-test-only")
    assert error.value.diagnostics["validation_errors"]
    assert "secret-invalid" not in json.dumps(error.value.diagnostics)


def test_legacy_list_type_failure_is_identifiable(monkeypatch):
    from types import SimpleNamespace
    import io
    response = {"stop_reason": "tool_use", "content": [{"type": "tool_use", "name": "submit_verdict", "input": {
        "recommendation": "allow", "risk": "low", "reason": "Routine read", "evidence": "Not an array", "missing_context": "None"}}]}
    class Opener:
        def open(self, *_args, **_kwargs):
            return io.BytesIO(json.dumps(response).encode())
    monkeypatch.setattr(judge.urllib.request, "build_opener", lambda *_: Opener())
    with pytest.raises(judge.JudgeError) as error:
        judge.evaluate(SimpleNamespace(model="test", snapshot={}, rules={}), "sk-ant-test-only")
    assert error.value.diagnostics["validation_errors"] == [{"field": "evidence", "type": "list_type"}, {"field": "missing_context", "type": "list_type"}]
