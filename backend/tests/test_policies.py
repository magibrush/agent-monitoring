import json
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from backend import main, policies, safety, hooks
from backend.db import PolicyState, PolicyVersion, PolicyChange, SafetyEvaluation, Connection
from backend.tests.test_monitor import store, transcript
from backend.tests.test_hooks import connection, envelope
from backend.tests.test_safety_performance import blocking


def setup(store, tmp_path, effect="allow"):
    (tmp_path / "README.md").write_text("Synthetic docs")
    with store() as db:
        c = db.scalar(select(Connection)) or connection(db, tmp_path); db.commit()
        return {"id": "read-docs", "name": "Read docs", "connection_id": c.id, "root": str(tmp_path), "operation": "read", "effect": effect, "extensions": [".md"], "expires_at": None}


def save(client, rule, name="Docs"):
    revision = client.get("/api/safety/policies").json()["revision"]
    response = client.post("/api/safety/policies/versions", json={"revision": revision, "name": name, "rules": [rule]})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def transition(client, version, action):
    return client.post("/api/safety/policies/transition", json={"revision": client.get("/api/safety/policies").json()["revision"], "version_id": version, "action": action})


def activate(client, id_):
    assert client.post(f"/api/safety/policies/versions/{id_}/preview").status_code == 200
    assert transition(client, id_, "trial").status_code == 200
    assert transition(client, id_, "activate").status_code == 200


def read_job(store, tmp_path, call="read", args=None):
    from uuid import uuid4
    path = tmp_path / "rollout.jsonl"; transcript(path, "codex_cli_rs")
    with store() as db:
        item = envelope(path, call=call, tool_name="Read", tool_input=args or {"file_path": str(tmp_path / "README.md")})
        item["request"] = {"id": str(uuid4()), "deadline": safety.later(60)}
        hooks.ingest(db, db.scalar(select(Connection)), item); db.commit()
        return db.scalar(select(SafetyEvaluation).where(SafetyEvaluation.request_key == item["request"]["id"]))


def test_preview_trial_activate_and_rollback_are_versioned(store, tmp_path):
    rule = setup(store, tmp_path); client = TestClient(main.app, base_url="http://localhost")
    id_ = save(client, rule)
    initial = read_job(store, tmp_path)
    assert initial.status == "queued"
    preview = client.post(f"/api/safety/policies/versions/{id_}/preview").json()
    assert preview["counts"]["allow"] == 1
    assert transition(client, id_, "trial").status_code == 200
    trial = read_job(store, tmp_path, "trial")
    assert trial.status == "queued" and trial.rules["trial"]["decision"] == "allow"
    assert transition(client, id_, "activate").status_code == 200
    allowed = read_job(store, tmp_path, "active")
    assert allowed.decision == "pass" and allowed.attempts == 0 and allowed.model == "policy"
    assert allowed.result["source"] == "policy" and allowed.rules["policy"]["version"] == id_
    assert allowed.returned_at is None  # Release still requires the bound hook receipt.
    rule["effect"] = "deny"
    second = save(client, rule, "Deny docs"); activate(client, second)
    denied = read_job(store, tmp_path, "denied")
    assert denied.decision == "deny" and denied.result["source"] == "policy"
    assert transition(client, id_, "rollback").status_code == 200
    assert read_job(store, tmp_path, "rolled-back").decision == "pass"
    with store() as db:
        assert db.get(SafetyEvaluation, denied.id).decision == "deny"
        assert db.get(SafetyEvaluation, initial.id).status == "queued"
        assert db.get(PolicyVersion, id_).rules[0]["effect"] == "allow"
    data = client.get("/api/safety/policies").json()
    assert data["active_id"] == id_ and data["versions"][1]["trial"]["allow"] == 1
    assert data["changes"][0]["action"] == "rollback"
    assert transition(client, None, "disable").status_code == 200
    assert read_job(store, tmp_path, "disabled").status == "queued"


def test_policy_review_needs_human_and_obeys_capacity(store, tmp_path, monkeypatch):
    client = TestClient(main.app, base_url="http://localhost"); rule = setup(store, tmp_path, "review")
    activate(client, save(client, rule))
    job = read_job(store, tmp_path)
    assert job.status == "awaiting_review" and job.attempts == 0
    with store() as db:
        assert safety.human_review(db, job.id, "approve", job.input_hash)
    monkeypatch.setattr(safety, "MAX_BLOCKING_PER_CONNECTION", 0)
    assert read_job(store, tmp_path, "overload").decision == "error"


@pytest.mark.parametrize("change", ["opaque", "outside", "sensitive", "missing", "shell", "expired", "connection"])
def test_narrow_allow_scope(store, tmp_path, change):
    rule = setup(store, tmp_path)
    payload = {"tool_name": "Read", "tool_input": {"file_path": str(tmp_path / "README.md")}}
    if change == "opaque": payload["tool_input"]["command"] = "arbitrary code"
    if change == "outside": payload["tool_input"]["file_path"] = str(tmp_path.parent / "README.md")
    if change == "sensitive":
        (tmp_path / "secrets.md").write_text("synthetic")
        payload["tool_input"]["file_path"] = str(tmp_path / "secrets.md")
    if change == "missing": payload["tool_input"]["file_path"] = str(tmp_path / "missing.md")
    if change == "shell": payload = {"tool_name": "Bash", "tool_input": {"command": "cat README.md"}}
    if change == "expired": rule["expires_at"] = safety.later(-1)
    result = policies.match(SimpleNamespace(id=1, rules=[rule]), payload, "other" if change == "connection" else rule["connection_id"])
    assert result["decision"] == "none"


def test_builtin_deny_and_conflict_precedence(store, tmp_path):
    rule = setup(store, tmp_path)
    payload = {"tool_name": "Read", "tool_input": {"file_path": str(tmp_path / "README.md")}}
    version = SimpleNamespace(id=1, rules=[rule, {**rule, "id": "ask", "effect": "review"}])
    assert policies.match(version, payload, rule["connection_id"])["decision"] == "review"
    version.rules.append({**rule, "id": "block", "effect": "deny"})
    assert policies.match(version, payload, rule["connection_id"])["decision"] == "deny"
    assert policies.conflicts(version.rules)
    result = policies.match(SimpleNamespace(id=1, rules=[rule]), payload, rule["connection_id"], {"decision": "deny", "findings": []})
    assert result["decision"] == "deny" and result["rule_ids"] == []


def test_stale_edits_and_unsafe_rules_rejected(store, tmp_path):
    rule = setup(store, tmp_path); client = TestClient(main.app, base_url="http://localhost")
    save(client, rule)
    assert client.post("/api/safety/policies/versions", json={"revision": 0, "name": "stale", "rules": [rule]}).status_code == 409
    revision = client.get("/api/safety/policies").json()["revision"]
    for unsafe in ({**rule, "operation": "write"}, {**rule, "extensions": [".pem"]}, {**rule, "root": str(tmp_path.anchor)}):
        assert client.post("/api/safety/policies/versions", json={"revision": revision, "name": "unsafe", "rules": [unsafe]}).status_code == 422


def test_links_never_receive_fast_approval(store, tmp_path, monkeypatch):
    rule = setup(store, tmp_path)
    monkeypatch.setattr(policies, "linked", lambda path: True)
    assert policies.match(SimpleNamespace(id=1, rules=[rule]), {"tool_name": "Read", "tool_input": {"file_path": str(tmp_path / "README.md")}}, rule["connection_id"])["decision"] == "none"


def test_fast_policy_release_uses_real_hook_receipt_without_worker(store, tmp_path, monkeypatch):
    from backend.db import ROOT
    monkeypatch.setenv("RELAY_HOOK_QUEUE", str(tmp_path / "queue"))
    client = TestClient(main.app, base_url="http://localhost")
    rule = setup(store, tmp_path); activate(client, save(client, rule))
    path = tmp_path / "rollout.jsonl"; transcript(path, "codex_cli_rs")
    with store() as db:
        c = db.scalar(select(Connection)); c.gate_enabled = True; db.commit()
        queue = hooks.queue_path(c)
    queue.mkdir(parents=True); (queue / "enabled").touch(); (queue / "gate-enabled").touch()
    process = subprocess.Popen([sys.executable, str(ROOT / "scripts/gate_hook.py"), str(queue), "codex_cli", str(tmp_path)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        payload = envelope(path, tool_name="Read", tool_input={"file_path": str(tmp_path / "README.md")})["payload"]
        process.stdin.write(json.dumps(payload).encode()); process.stdin.close()
        deadline = time.monotonic() + 8
        while process.poll() is None and time.monotonic() < deadline:
            main.synchronize_hooks(); time.sleep(.05)
        assert process.wait(timeout=2) == 0
        assert process.stdout.read() == b""
        main.synchronize_hooks()
        with store() as db:
            job = db.scalar(select(SafetyEvaluation))
            assert job.model == "policy" and job.attempts == 0
            assert job.returned_at and job.gate["decision"] == "pass"
    finally:
        if process.poll() is None:
            process.kill(); process.wait()


def test_shadow_connection_does_not_request_human_or_release_gate(store, tmp_path):
    client = TestClient(main.app, base_url="http://localhost")
    rule = setup(store, tmp_path, "review"); activate(client, save(client, rule))
    path = tmp_path / "rollout.jsonl"; transcript(path, "codex_cli_rs")
    with store() as db:
        hooks.ingest(db, db.scalar(select(Connection)), envelope(path, tool_name="Read", tool_input={"file_path": str(tmp_path / "README.md")}))
        db.commit(); job = db.scalar(select(SafetyEvaluation))
        assert job.mode == "shadow" and job.status == "completed"
        assert job.decision is None and job.result["recommendation"] == "review"
