import json
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from backend import main
from backend.claude_code import sync_claude
from backend.db import ChatSession, Connection, Event
from backend.normalization import action_category
from backend.tests.test_monitor import store


def record(uuid, role, content, **extra):
    return json.dumps({"uuid": uuid, "sessionId": "main-session", "type": role,
                       "timestamp": datetime.now(timezone.utc).isoformat(),
                       "message": {"role": role, "content": content}, **extra}) + "\n"


def fixture(root):
    project = root / "projects" / "encoded-project"
    project.mkdir(parents=True)
    path = project / "main-session.jsonl"
    path.write_text(json.dumps({"type": "file-history-snapshot"}) + "\n" +
                    record("u1", "user", "Inspect the Claude workspace") +
                    record("a1", "assistant", [
                        {"type": "thinking", "thinking": "not visible text"},
                        {"type": "text", "text": "Reading the file"},
                        {"type": "tool_use", "id": "read-1", "name": "Read", "input": {"file_path": "README.md"}},
                        {"type": "tool_use", "id": "write-1", "name": "Write", "input": {"file_path": "script.sh", "content": "rm scratch"}},
                        {"type": "text", "text": "Then writing the script"}]) +
                    record("u2", "user", [
                        {"type": "tool_result", "tool_use_id": "read-1", "content": [{"type": "text", "text": "Repository instructions"}]},
                        {"type": "tool_result", "tool_use_id": "write-1", "content": "Permission denied", "is_error": True}]), encoding="utf-8")
    sub = project / "main-session" / "subagents"
    sub.mkdir(parents=True)
    for agent in ("one", "two"):
        (sub / f"agent-{agent}.jsonl").write_text(
            record("same-uuid", "user", f"Explore as {agent}", agentId=agent, isSidechain=True), encoding="utf-8")
    return path


def test_claude_blocks_resume_partial_and_subagents(store, tmp_path):
    path = fixture(tmp_path)
    with store() as db:
        c = Connection(name="Claude", provider="claude_code", path=str(tmp_path))
        db.add(c); db.flush()
        assert sync_claude(db, c) == 9
        db.commit(); connection_id = c.id
    with store() as db:
        c = db.get(Connection, connection_id)
        assert sync_claude(db, c) == 0
        sessions = list(db.scalars(select(ChatSession)))
        assert len(sessions) == 3
        assert sum(s.session_type == "subagent" and s.parent_thread_id == "main-session" for s in sessions) == 2
        tools = list(db.scalars(select(Event).where(Event.kind.in_(["tool_call", "tool_result"])).order_by(Event.id)))
        assert [e.tool_call_id for e in tools] == ["read-1", "write-1", "read-1", "write-1"]
        assert [e.action_category for e in tools[:2]] == ["read", "file_write"]
        assert tools[-1].text == "Error: Permission denied"
        resumed = record("a2", "assistant", "Resumed successfully")
        with path.open("a", encoding="utf-8") as stream:
            stream.write(resumed[:-1])
        assert sync_claude(db, c) == 0
        with path.open("a", encoding="utf-8") as stream:
            stream.write("\n" + resumed)  # same UUID replay must not duplicate
        assert sync_claude(db, c) == 1
        db.commit()
        assert sync_claude(db, c) == 0
        assert len(list(db.scalars(select(ChatSession)))) == 3
        path.write_text("", encoding="utf-8")
        with pytest.raises(ValueError, match="truncated"):
            sync_claude(db, c)


def test_claude_api_discovery_filters_and_legacy_isolation(store, tmp_path, monkeypatch):
    path = fixture(tmp_path)
    originals = {p: p.read_bytes() for p in tmp_path.rglob("*.jsonl")}
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path))
    client = TestClient(main.app, base_url="http://localhost")
    config = client.get("/api/config").json()
    assert next(p for p in config["providers"] if p["id"] == "claude_code")["default_path"] == str(tmp_path / "projects")
    assert any(s["adapter"] == "claude_code" and s["matching_sessions"] == 3 for s in config["sources"])
    checked = client.post("/api/connections/check", json={"provider": "claude_code", "path": str(tmp_path)}).json()
    assert checked["matching_sessions"] == 3 and checked["counts"]["subagents"] == 2
    c = client.post("/api/connections", json={"name": "Claude", "provider": "claude_code", "path": str(tmp_path)}).json()
    assert c["path"] == str(tmp_path / "projects")
    with store() as db:
        legacy = Connection(name="Retired Desktop", provider="claude", path=str(tmp_path))
        db.add(legacy); db.flush()
        session = ChatSession(connection_id=legacy.id, external_id="old", title="Retired import", source="desktop", created_at=datetime.now(timezone.utc).isoformat(), updated_at=datetime.now(timezone.utc).isoformat())
        db.add(session); db.commit(); legacy_session = session.id
    main.synchronize()
    assert len(client.get("/api/connections").json()) == 1
    assert client.get(f"/api/sessions/{legacy_session}/events").status_code == 404
    assert client.post("/api/connections", json={"name": "Old", "provider": "claude", "path": str(tmp_path)}).status_code == 422
    assert client.get("/api/sessions", params={"provider": "claude_code", "session_type": "subagent"}).json()["total"] == 2
    items = client.get("/api/sessions", params={"q": "instructions", "search_scope": "actions"}).json()["items"]
    assert len(items) == 1
    assert client.get(f'/api/sessions/{items[0]["id"]}/events').json()["total"] == 7
    metrics = client.get("/api/metrics", params={"provider": "claude_code", "action": "file_write", "conversations": True}).json()
    assert metrics["actions"] == 1
    assert sum(row["actions"] for row in metrics["series"]) == 1
    # Malformed appended data is surfaced as a sync error without advancing.
    with path.open("a", encoding="utf-8") as stream:
        stream.write("invalid-json\n")
    assert client.post(f'/api/connections/{c["id"]}/sync').json()["status"] == "error"
    path.write_bytes(originals[path])
    assert client.post(f'/api/connections/{c["id"]}/sync').json()["status"] == "watching"
    assert client.delete(f'/api/connections/{c["id"]}').status_code == 200
    assert all(p.read_bytes() == data for p, data in originals.items())


@pytest.mark.parametrize("tool,category", [("Read", "read"), ("Grep", "read"), ("Glob", "read"),
    ("Write", "file_write"), ("Edit", "file_write"), ("NotebookEdit", "file_write"),
    ("Bash", "shell"), ("WebFetch", "network"), ("WebSearch", "network")])
def test_claude_tool_mapping(tool, category):
    assert action_category(tool, '{"command":"pwd"}') == category
