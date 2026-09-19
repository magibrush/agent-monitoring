import json
from fastapi.testclient import TestClient
from sqlalchemy import select
from backend import main
from backend.db import Connection, Checkpoint, TokenUsage
from backend.connectors import sync_codex
from backend.claude_code import sync_claude
from backend.tests.test_monitor import store
from backend.token_usage import codex


def test_codex_cumulative_usage_resume_replay_and_time_buckets(store, tmp_path):
    def record(kind, payload, minute):
        return json.dumps({"type": kind, "timestamp": f"2026-09-19T10:{minute:02}:00+00:00", "payload": payload}) + "\n"
    def usage(inp, out, minute):
        return record("event_msg", {"type": "token_count", "info": {"total_token_usage": {"input_tokens": inp, "output_tokens": out, "total_tokens": inp + out}}}, minute)
    path = tmp_path / "rollout.jsonl"
    path.write_text(record("session_meta", {"id": "tokens", "originator": "Codex Desktop"}, 0) + record("response_item", {"type": "message", "role": "user", "content": "Hello"}, 0) + usage(100, 20, 1) + usage(100, 20, 2), encoding="utf-8")
    with store() as db:
        c = Connection(name="tokens", provider="codex", path=str(tmp_path)); db.add(c); db.flush()
        sync_codex(db, c); db.commit(); cid = c.id
    with path.open("a", encoding="utf-8") as stream: stream.write(usage(150, 30, 6) + usage(20, 5, 7))
    with store() as db:
        c = db.get(Connection, cid); sync_codex(db, c); db.commit()
        cp = db.scalar(select(Checkpoint)); cp.offset = 0; cp.record_counts = None; db.commit()
        sync_codex(db, c); db.commit()
        assert len(list(db.scalars(select(TokenUsage)))) == 3
    client = TestClient(main.app, base_url="http://localhost")
    session = client.get("/api/sessions").json()["items"][0]
    assert (session["input_tokens"], session["output_tokens"]) == (170, 35)
    filtered = client.get("/api/sessions", params={"start": "2026-09-19T10:05:00Z", "end": "2026-09-19T10:10:00Z"}).json()
    # Session selection still depends on recorded activity, not synthetic usage events.
    assert filtered["total"] == 0
    buckets = client.get("/api/metrics", params={"interval": 300, "view_start": "2026-09-19T10:00:00Z", "view_end": "2026-09-19T10:10:00Z"}).json()["series"]
    assert [r["input_tokens"] for r in buckets] == [100, 70, None]
    assert [r["output_tokens"] for r in buckets] == [20, 15, None]


def test_claude_usage_deduplicates_message_blocks_and_counts_cache(store, tmp_path):
    def record(uuid, output):
        return json.dumps({"uuid": uuid, "sessionId": "claude", "type": "assistant", "timestamp": "2026-09-19T10:01:00Z", "message": {"id": "msg-1", "content": [{"type": "text", "text": "Hello"}, {"type": "tool_use", "id": "tool-1", "name": "Read", "input": {}}], "usage": {"input_tokens": 2, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 10, "output_tokens": output}}}) + "\n"
    (tmp_path / "session.jsonl").write_text(record("a", 3) + record("b", 8), encoding="utf-8")
    with store() as db:
        c = Connection(name="Claude", provider="claude_code", path=str(tmp_path)); db.add(c); db.flush()
        sync_claude(db, c); sync_claude(db, c); db.commit()
        rows = list(db.scalars(select(TokenUsage)))
        assert len(rows) == 1
        assert (rows[0].input_tokens, rows[0].output_tokens) == (112, 8)


def test_missing_split_is_unknown_not_zero(store, tmp_path):
    from backend.db import ChatSession
    with store() as db:
        c = Connection(name="unknown", provider="codex", path=str(tmp_path)); db.add(c); db.flush()
        session = ChatSession(connection_id=c.id, external_id="unknown", title="unknown", created_at="2026-09-19T10:00:00+00:00", updated_at="2026-09-19T10:00:00+00:00", source="desktop"); db.add(session); db.flush()
        record = {"payload": {"info": {"total_token_usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 1234}}}}
        codex(db, session, record, session.created_at, {})
        row = db.scalar(select(TokenUsage))
        assert row.input_tokens is None and row.output_tokens is None
