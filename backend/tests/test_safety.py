import io
import json
import os
from concurrent.futures import ThreadPoolExecutor
import subprocess
import sys
import threading
from types import SimpleNamespace
import urllib.error

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, func, update

from backend import hooks, main, safety, judge, safety_worker
from backend.db import Event, SafetyEvaluation, ROOT, Connection
from backend.safety_policy import assess, MODEL
from backend.tests.test_monitor import store, transcript
from backend.tests.test_hooks import connection, envelope


def add_job(store, tmp_path, call="call-1", **extra):
    path = tmp_path / "rollout.jsonl"
    transcript(path, "codex_cli_rs")
    with store() as db:
        c = db.scalar(select(Connection)) or connection(db, tmp_path)
        hooks.ingest(db, c, envelope(path, call=call, **extra))
        db.commit()
        return db.scalar(select(SafetyEvaluation).order_by(SafetyEvaluation.created_at.desc())).id


def test_transactional_dedup_and_changed_input(store, tmp_path):
    first = add_job(store, tmp_path)
    assert add_job(store, tmp_path) == first
    add_job(store, tmp_path, tool_input={"command": "echo changed"})
    with store() as db:
        assert db.scalar(select(func.count()).select_from(SafetyEvaluation)) == 2
        c = db.scalar(select(Connection))
        hooks.ingest(db, c, envelope(tmp_path / "rollout.jsonl", call="rolled-back"))
        db.rollback()
        assert db.scalar(select(func.count()).select_from(SafetyEvaluation)) == 2


def test_parallel_claims_do_not_duplicate(store, tmp_path):
    for i in range(8):
        add_job(store, tmp_path, call=f"parallel-{i}")
    with ThreadPoolExecutor(max_workers=8) as pool:
        jobs = list(pool.map(lambda _: safety.claim(store), range(8)))
    claimed = [j.id for j in jobs if j]
    assert claimed and len(claimed) == len(set(claimed))
    while job := safety.claim(store):
        assert job.id not in claimed
        claimed.append(job.id)
    assert len(claimed) == 8


def test_lease_recovery_fences_late_results(store, tmp_path):
    add_job(store, tmp_path)
    stale = safety.claim(store)
    with store() as db:
        db.execute(update(SafetyEvaluation).values(lease_until=safety.later(-1)))
        db.commit()
    current = safety.claim(store)
    assert current.id == stale.id and current.lease_token != stale.lease_token
    assert not safety.finish(store, stale, result={"recommendation": "allow"})
    assert safety.finish(store, current, result={"recommendation": "review"})
    assert not safety.finish(store, current, result={"recommendation": "allow"})


def test_missing_key_does_not_consume_attempts_and_parallel_workers(store, tmp_path, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    key = tmp_path / "anthropic.key"
    key.write_text("")
    monkeypatch.setenv("RELAY_ANTHROPIC_KEY_FILE", str(key))
    add_job(store, tmp_path, call="one")
    add_job(store, tmp_path, call="two")
    assert not safety_worker.run_one(store)
    with store() as db:
        assert all(j.attempts == 0 for j in db.scalars(select(SafetyEvaluation)))
    key.write_text("sk-ant-test-only")
    barrier = threading.Barrier(2)
    def evaluator(job, supplied_key):
        assert supplied_key == "sk-ant-test-only" and job.model == MODEL
        barrier.wait(timeout=10)
        return {"recommendation": "review", "source": "judge"}, {"input_tokens": 10, "output_tokens": 3}
    # Claims can race for the same first row; a worker losing the claim polls again.
    def work():
        for _ in range(10):
            if safety_worker.run_one(store, evaluator):
                return True
        return False
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: work(), range(2)))
    assert results == [True, True]
    with store() as db:
        assert all(j.status == "completed" and j.attempts == 1 for j in db.scalars(select(SafetyEvaluation)))


def test_bounded_retries_and_expiration(store, tmp_path):
    add_job(store, tmp_path)
    for attempt in range(1, 4):
        job = safety.claim(store)
        assert job.attempts == attempt
        safety.finish(store, job, error="timeout", retryable=True)
        with store() as db:
            saved = db.get(SafetyEvaluation, job.id)
            assert saved.status == ("queued" if attempt < 3 else "failed")
            saved.available_at = safety.later(-1)
            db.commit()
    assert safety.claim(store) is None
    expired = add_job(store, tmp_path, call="expired")
    with store() as db:
        db.get(SafetyEvaluation, expired).created_at = safety.later(-90000)
        db.commit()
    assert safety.claim(store) is None


def test_capacity_and_rules_do_not_depend_on_model(store, tmp_path, monkeypatch):
    monkeypatch.setattr(safety, "MAX_PENDING", 0)
    skipped = add_job(store, tmp_path)
    denied = add_job(store, tmp_path, call="root-delete", tool_input={"command": "rm -rf /"})
    with store() as db:
        assert db.get(SafetyEvaluation, skipped).status == "skipped"
        job = db.get(SafetyEvaluation, denied)
        assert job.status == "completed" and job.result["recommendation"] == "deny" and job.attempts == 0


def test_redaction_and_snapshot_limits(store, tmp_path):
    id_ = add_job(store, tmp_path, tool_input={"command": "echo sk-ant-secret-example " + "x" * 25000})
    with store() as db:
        job = db.get(SafetyEvaluation, id_)
        assert "sk-ant-secret-example" not in json.dumps(job.snapshot)
        assert job.snapshot["action_truncated"]


def test_judge_validates_response_and_request(monkeypatch):
    verdict = {"recommendation": "allow", "risk": "low", "reason": "Read operation", "evidence": [], "missing_context": []}
    response = {"stop_reason": "tool_use", "content": [{"type": "tool_use", "name": "submit_verdict", "input": verdict}], "usage": {"input_tokens": 15, "output_tokens": 10}}
    class Opener:
        def open(self, request, timeout):
            assert request.full_url == "https://api.anthropic.com/v1/messages" and timeout == 25
            body = json.loads(request.data)
            assert body["model"] == MODEL and body["tool_choice"]["name"] == "submit_verdict"
            return io.BytesIO(json.dumps(response).encode())
    monkeypatch.setattr(judge.urllib.request, "build_opener", lambda *_: Opener())
    job = SimpleNamespace(model=MODEL, snapshot={"action_truncated": True}, rules={"decision": "review"})
    actual, usage = judge.evaluate(job, "sk-ant-test-only")
    assert actual["recommendation"] == "review" and usage["input_tokens"] == 15
    response["content"][0]["input"]["recommendation"] = "execute"
    with pytest.raises(judge.JudgeError, match="schema validation"):
        judge.evaluate(job, "sk-ant-test-only")
    response["stop_reason"] = "max_tokens"
    with pytest.raises(judge.JudgeError, match="incomplete"):
        judge.evaluate(job, "sk-ant-test-only")


@pytest.mark.parametrize("code,retryable", [(401, False), (429, True), (500, True)])
def test_api_errors_never_store_response_or_key(monkeypatch, code, retryable):
    class Opener:
        def open(self, *_args, **_kwargs):
            raise urllib.error.HTTPError("https://api.anthropic.com", code, "sk-ant-do-not-store", {}, io.BytesIO(b"sensitive body"))
    monkeypatch.setattr(judge.urllib.request, "build_opener", lambda *_: Opener())
    with pytest.raises(judge.JudgeError) as error:
        judge.evaluate(SimpleNamespace(model=MODEL, snapshot={}, rules={}), "sk-ant-test-only")
    assert error.value.retryable == retryable
    assert "sensitive" not in str(error.value) and "sk-ant" not in str(error.value)


@pytest.mark.parametrize("command,denied", [("rm -rf /", True), ("rm -rf ./build", False), ("echo 'rm -rf /'", False), ("python script.py", False)])
def test_narrow_shell_policy(command, denied):
    assert (assess({"tool_name": "Bash", "tool_input": {"command": command}})["decision"] == "deny") == denied


def test_gate_returns_deny_without_executing_and_pass_preserves_permissions(tmp_path):
    (tmp_path / "enabled").touch()
    (tmp_path / "gate-enabled").touch()
    def run(raw):
        return subprocess.run([sys.executable, str(ROOT / "scripts/gate_hook.py"), str(tmp_path)], input=raw, capture_output=True, timeout=8)
    payload = {"hook_event_name": "PreToolUse", "tool_name": "Write", "tool_input": {"file_path": str(ROOT / ".secrets/anthropic.key"), "content": "never written"}}
    result = run(json.dumps(payload).encode())
    assert result.returncode == 2 and not result.stdout and b"denied" in result.stderr
    assert run(b"malformed").returncode == 2
    (tmp_path / "gate-enabled").unlink()
    assert run(b"malformed").returncode == 0
    records = [json.loads(p.read_text()) for p in tmp_path.glob("*.json")]
    assert {r["gate"]["decision"] for r in records} == {"deny"}


def test_gate_configuration_and_api_delete_running_job(store, tmp_path, monkeypatch):
    monkeypatch.setenv("RELAY_HOOK_QUEUE", str(tmp_path / "queue"))
    root = tmp_path / "sessions"
    root.mkdir()
    with store() as db:
        c = connection(db, root); db.commit(); cid = c.id
    client = TestClient(main.app, base_url="http://localhost")
    url = f"/api/connections/{cid}/hooks"
    assert client.get(url + "?gate_enabled=true").json()["mode"] == "blocking"
    with store() as db:
        assert not db.get(Connection, cid).gate_enabled  # Preview is not a mutation.
    assert client.patch(url, json={"enabled": True, "gate_enabled": True}).status_code == 200
    document = json.loads((tmp_path / "hooks.json").read_text())
    assert "gate_hook.py" in document["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
    assert (tmp_path / "queue" / cid / "gate-enabled").exists()
    path = root / "rollout.jsonl"; transcript(path, "codex_cli_rs")
    with store() as db:
        hooks.ingest(db, db.get(Connection, cid), envelope(path)); db.commit()
    job = safety.claim(store)
    assert client.get(f"/api/safety/evaluations/{job.id}").status_code == 200
    assert client.get("/api/safety").json()["counts"]["running"] == 1
    assert client.delete(f"/api/connections/{cid}").status_code == 200
    assert not safety.finish(store, job, result={"recommendation": "allow"})
    assert not (tmp_path / "queue" / cid / "gate-enabled").exists()


def test_gate_shared_profile_provenance_and_recording_failure(tmp_path, monkeypatch, capsys):
    from scripts import gate_hook
    path = tmp_path / "rollout.jsonl"
    transcript(path, "Codex Desktop")
    payload = {"transcript_path": str(path), "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "echo harmless"}}
    assert not gate_hook.matches_connection(payload, "codex_cli", tmp_path)
    assert gate_hook.matches_connection(payload, "codex", tmp_path)
    assert not gate_hook.matches_connection(payload, "codex", tmp_path / "different")
    path.write_text("partial")
    with pytest.raises(ValueError):
        gate_hook.matches_connection(payload, "codex", tmp_path)
    (tmp_path / "enabled").touch(); (tmp_path / "gate-enabled").touch()
    monkeypatch.setattr(sys, "argv", ["gate_hook.py", str(tmp_path)])
    monkeypatch.setattr(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(json.dumps(payload).encode())))
    def broken_spool(*_args, **_kwargs):
        raise OSError("disk full")
    monkeypatch.setattr(gate_hook, "capture", broken_spool)
    assert gate_hook.main() == 2
    assert "could not validate or record" in capsys.readouterr().err


def test_migration_upgrade_and_downgrade(tmp_path):
    env = {**os.environ, "DATABASE_URL": "sqlite:///" + (tmp_path / "migration.db").as_posix()}
    for target in ("0006", "0004", "0006", "head"):
        operation = "downgrade" if target == "0004" else "upgrade"
        result = subprocess.run([sys.executable, "-m", "alembic", operation, target], cwd=ROOT, env=env, capture_output=True, timeout=20)
        assert result.returncode == 0, result.stderr.decode()
