import io
import json
import subprocess
import sys

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, func

from backend import hooks, main
from backend.connectors import sync_connection
from backend.db import Connection, Event, HookObservation, ChatSession, now, ROOT
from backend.tests.test_monitor import store, transcript
from backend.tests.test_claude_code import fixture
from scripts.observe_hook import capture


def connection(db, root, provider="codex_cli"):
    c = Connection(name="Hooks", provider=provider, path=str(root), hooks_enabled=True)
    db.add(c); db.flush()
    return c


def envelope(path, phase="PreToolUse", call="call-1", session="session-1", **extra):
    return {"received_at": now(), "payload": {"session_id": session, "transcript_path": str(path),
        "hook_event_name": phase, "tool_use_id": call, "tool_name": "Bash", "tool_input": {"command": "pwd"}, **extra}}


@pytest.mark.parametrize("first", ["hook", "transcript"])
@pytest.mark.parametrize("provider", ["codex", "codex_cli", "claude_code"])
def test_reconcile_both_orders_and_replay(store, tmp_path, first, provider):
    if provider == "claude_code":
        path = fixture(tmp_path)
        item = envelope(path, call="read-1", session="main-session")
    else:
        path = tmp_path / "rollout.jsonl"
        transcript(path, "Codex Desktop" if provider == "codex" else "codex_cli_rs")
        item = envelope(path)
    with store() as db:
        c = connection(db, tmp_path, provider)
        if first == "hook": hooks.ingest(db, c, item)
        sync_connection(db, c)
        hooks.ingest(db, c, item)
        hooks.ingest(db, c, item)
        observed = db.scalar(select(Event).where(Event.tool_call_id == item["payload"]["tool_use_id"], Event.kind == "tool_call"))
        assert observed.hook_state == "unknown"  # Transcript result already exists.
        post = {**item, "payload": {**item["payload"], "hook_event_name": "PostToolUse", "tool_response": {"exit_code": 0}}}
        hooks.ingest(db, c, post)
        hooks.ingest(db, c, item)  # late pre / duplicate must not regress
        db.commit()
        event = db.scalar(select(Event).where(Event.tool_call_id == item["payload"]["tool_use_id"], Event.kind == "tool_call"))
        assert event.transcript_seen and event.hook_state == "completed"
        assert db.scalar(select(func.count()).select_from(HookObservation)) == 2
        before = db.scalar(select(func.count()).select_from(Event))
        assert sync_connection(db, c) == 0
        assert db.scalar(select(func.count()).select_from(Event)) == before
        assert db.scalar(select(func.count()).select_from(Event).where(Event.kind == "tool_call", Event.tool_call_id == item["payload"]["tool_use_id"])) == 1


def test_outcomes_unknown_failure_late_pre(store, tmp_path):
    path = tmp_path / "rollout.jsonl"; transcript(path, "codex_cli_rs")
    with store() as db:
        c = connection(db, tmp_path)
        hooks.ingest(db, c, envelope(path, "PostToolUse", tool_response="opaque output"))
        hooks.ingest(db, c, envelope(path))
        event = db.scalar(select(Event))
        assert event.hook_state == "unknown"
        hooks.ingest(db, c, envelope(path, "PostToolUse", call="failed", tool_response={"exit_code": 1}))
        assert db.scalar(select(Event).where(Event.tool_call_id == "failed")).hook_state == "failed"
        assert hooks.outcome({"hook_event_name": "PostToolUseFailure"}) == "failed"
        assert hooks.outcome({"hook_event_name": "PermissionDenied"}) == "denied"


def test_queue_offline_partial_replay_pause_and_budget(store, tmp_path, monkeypatch):
    monkeypatch.setenv("RELAY_HOOK_QUEUE", str(tmp_path / "queue"))
    path = tmp_path / "rollout.jsonl"; transcript(path, "codex_cli_rs")
    with store() as db:
        c = connection(db, tmp_path); db.commit(); cid = c.id
        queue = hooks.queue_path(c); queue.mkdir(parents=True); (queue / "enabled").touch()
        raw = json.dumps(envelope(path)["payload"]).encode()
        capture(queue, io.BytesIO(raw)); capture(queue, io.BytesIO(raw))
        (queue / "partial.tmp").write_text('{"payload":')
        c.enabled = False; db.commit()
    main.synchronize_hooks()
    assert len(list(queue.glob("*.json"))) == 2
    with store() as db:
        c = db.get(Connection, cid); c.enabled = True
        hooks.collect(db, c, limit=1)
        assert len(list(queue.glob("*.json"))) == 1
    with store() as db:
        hooks.collect(db, db.get(Connection, cid))
        assert db.scalar(select(func.count()).select_from(HookObservation)) == 1
        assert (queue / "partial.tmp").exists()
        assert not list(queue.glob("*.json"))


def test_wrong_profile_source_and_subagent_identity(store, tmp_path):
    path = fixture(tmp_path)
    sub = path.parent / "main-session/subagents/agent-one.jsonl"
    with store() as db:
        c = connection(db, tmp_path, "claude_code")
        hooks.ingest(db, c, envelope(sub, session="main-session"))
        assert db.scalar(select(ChatSession.external_id)) == "main-session:agent:one"
        with pytest.raises(ValueError, match="identity"):
            hooks.ingest(db, c, envelope(path, session="wrong"))
        outside = tmp_path.parent / "not-read.jsonl"
        hooks.ingest(db, c, envelope(outside))
        codex = tmp_path / "rollout.jsonl"; transcript(codex, "Codex Desktop")
        cli = connection(db, tmp_path)
        hooks.ingest(db, cli, envelope(codex))
        assert db.scalar(select(func.count()).select_from(HookObservation)) == 1


def test_config_merge_disable_and_delete(store, tmp_path, monkeypatch):
    monkeypatch.setenv("RELAY_HOOK_QUEUE", str(tmp_path / "queue"))
    root = tmp_path / "projects"; root.mkdir()
    target = tmp_path / "settings.json"
    existing = {"permissions": {"deny": ["Bash(rm *)"]}, "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "existing-observer"}]}]}}
    target.write_text(json.dumps(existing))
    with store() as db:
        c = connection(db, root, "claude_code"); db.commit(); cid = c.id
    client = TestClient(main.app, base_url="http://localhost")
    url = f"/api/connections/{cid}/hooks"
    assert client.get(url).json()["mode"] == "observation"
    for _ in range(2): assert client.patch(url, json={"enabled": True}).status_code == 200
    config = json.loads(target.read_text())
    assert config["permissions"] == existing["permissions"]
    assert len(config["hooks"]["PreToolUse"]) == 2
    assert client.patch(url, json={"enabled": False}).status_code == 200
    assert json.loads(target.read_text())["hooks"]["PreToolUse"] == existing["hooks"]["PreToolUse"]
    assert not (tmp_path / "queue" / cid / "enabled").exists()
    assert client.delete(f"/api/connections/{cid}").status_code == 200


def test_observer_never_returns_decision(tmp_path):
    for raw in [b"not json", json.dumps({"hook_event_name": "PreToolUse"}).encode()]:
        result = subprocess.run([sys.executable, str(ROOT / "scripts/observe_hook.py"), str(tmp_path)], input=raw, capture_output=True)
        assert result.returncode == 0 and not result.stdout and not result.stderr
