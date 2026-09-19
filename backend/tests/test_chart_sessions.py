from fastapi.testclient import TestClient
from backend import main
from backend.db import ChatSession, Event
from backend.tests.test_monitor import store
from backend.tests.test_hooks import connection


def test_active_sessions_are_distinct_per_bucket_and_respect_scope(store, tmp_path):
    with store() as db:
        c = connection(db, tmp_path)
        for ident in ("a", "b"):
            db.add(ChatSession(id=ident, connection_id=c.id, external_id=ident, title=ident, created_at="2026-09-19T10:00:00+00:00", updated_at="2026-09-19T10:10:00+00:00", source="cli"))
        db.flush()
        for n, (session, minute) in enumerate([("a", 0), ("a", 0), ("b", 0), ("a", 5)]):
            db.add(Event(session_id=session, external_id=str(n), kind="message", role="user", text="hello", payload={}, occurred_at=f"2026-09-19T10:0{minute}:00+00:00"))
        db.commit()
    client = TestClient(main.app, base_url="http://localhost")
    query = {"start": "2026-09-19T10:00:00Z", "end": "2026-09-19T10:10:00Z", "interval": 300}
    result = client.get("/api/metrics", params=query).json()
    assert result["sessions"] == 2
    assert [r["sessions"] for r in result["series"]] == [2, 1, 0]
    subset = client.get("/api/metrics", params={**query, "session_ids": "a"}).json()
    assert [r["sessions"] for r in subset["series"]] == [1, 1, 0]
    zoom = client.get("/api/metrics", params={**query, "view_start": "2026-09-19T10:05:00Z", "view_end": "2026-09-19T10:10:00Z"}).json()
    assert zoom["sessions"] == 2  # Card totals keep the selected scope.
    assert [r["sessions"] for r in zoom["series"]] == [1, 0]


def test_message_contributors_exclude_action_only_sessions_before_pagination(store, tmp_path):
    with store() as db:
        c = connection(db, tmp_path)
        for ident in ("a", "b", "c"):
            db.add(ChatSession(id=ident, connection_id=c.id, external_id=ident, title=ident, created_at="2026-09-19T10:00:00+00:00", updated_at="2026-09-19T10:10:00+00:00", source="cli"))
        db.flush()
        for ident, kind in (("a", "message"), ("b", "tool_call"), ("c", "message")):
            db.add(Event(session_id=ident, external_id=ident, kind=kind, role="user", text="synthetic", payload={}, occurred_at="2026-09-19T10:05:00+00:00"))
        db.commit()
    client = TestClient(main.app, base_url="http://localhost")
    query = {"messages_only": True, "sort": "title", "limit": 1}
    first = client.get("/api/sessions", params=query).json()
    second = client.get("/api/sessions", params={**query, "offset": 1}).json()
    assert first["total"] == second["total"] == 2
    assert [first["items"][0]["id"], second["items"][0]["id"]] == ["a", "c"]
    assert client.get("/api/sessions", params={**query, "end": "2026-09-19T10:05:00Z"}).json()["total"] == 0
