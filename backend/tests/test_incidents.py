import hashlib
import json
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from backend import incidents, main
from backend.db import (ChatSession, Connection, Event, Incident, IncidentActivity,
    IncidentCandidate, IncidentLink, IncidentMonitor, SafetyEvaluation, now)
from backend.tests.test_monitor import store

BASE = "/api/safety/incidents"


def stamp(minutes=0):
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat()


def seed(store):
    with store() as db:
        db.add(IncidentMonitor(id=1, enabled_at=stamp(-60)))
        db.add_all([Connection(id="one", name="Claude", provider="claude_code", path=""), Connection(id="two", name="Codex", provider="codex", path="")])
        db.flush()
        for id_, connection in (("session", "one"), ("other-session", "one"), ("other-connection", "two")):
            db.add(ChatSession(id=id_, connection_id=connection, external_id=id_, title="Checkout refactor", created_at=now(), updated_at=now(), source="test"))
        db.commit()


def job(store, source="policy", session="session", path="D:/project/.env", at=None, status="completed", decision="deny", debug=None, retry=False):
    with store() as db:
        action = json.dumps({"tool_name": "Read", "tool_input": {"file_path": path}, "cwd": "D:/project"})
        event = Event(session_id=session, external_id=now(), kind="tool_call", role="assistant", text=action, tool_name="Read", occurred_at=at or now(), payload={}, hook_state="requested")
        db.add(event); db.flush()
        row = SafetyEvaluation(event_id=event.id, input_hash=hashlib.sha256(action.encode()).hexdigest(), request_key=now(), mode="blocking", status=status, created_at=at or now(),
            policy_version="test", model="test", snapshot={"action": action, "context": []}, debug_result=debug,
            rules={"findings": [{"id": "credential", "reason": "Protected file"}], "policy": {"rule_ids": ["env"], "version": 1, "reason": "Private configuration"}},
            result={"source": source, "recommendation": decision, "reason": "Private configuration read", "evidence": [], "missing_context": []},
            diagnostics={"retry_of": "original"} if retry else None, decision=decision)
        db.add(row); db.commit()
        return row.id, event.id


def scan(store, limit=100):
    with store() as db: return incidents.correlate(db, limit)


def client():
    return TestClient(main.app, base_url="http://localhost")


def test_threshold_scope_and_restart_idempotency(store):
    seed(store)
    ids = [job(store) for _ in range(2)]
    assert scan(store) == 2
    assert client().get(BASE).json()["total"] == 0
    ids.append(job(store)); scan(store)
    listing = client().get(BASE).json()
    assert listing["total"] == 1 and listing["items"][0]["action_count"] == 3
    job(store, session="other-session"); job(store, session="other-connection"); job(store, path="D:/elsewhere/.env")
    scan(store)
    assert scan(store) == 0
    assert client().get(BASE).json()["items"][0]["action_count"] == 3
    detail = client().get(BASE + "/" + listing["items"][0]["id"]).json()
    assert len(detail["actions"]) == 3 and "same file" in detail["grouping_reason"]
    assert {a["evaluation"]["id"] for a in detail["actions"]} == {i[0] for i in ids}


def test_immediate_concerns_exclusions_and_delayed_completion(store):
    seed(store)
    job(store, source="rules")
    job(store, source="judge", path="D:/other/key.pem")
    job(store, source="judge", debug="deny")
    job(store, source="judge", retry=True)
    job(store, source="judge", at=stamp(-120))
    waiting, _ = job(store, source="judge", status="running")
    job(store, decision="review", status="awaiting_review")
    scan(store)
    assert client().get(BASE).json()["total"] == 2
    with store() as db:
        db.get(SafetyEvaluation, waiting).status = "completed"; db.commit()
    assert scan(store) == 1
    assert client().get(BASE).json()["total"] == 3


def test_service_failures_group_across_sessions_but_not_connections(store):
    seed(store)
    for session in ("session", "other-session", "session"):
        job(store, session=session, status="failed", decision="error")
    job(store, session="other-connection", status="failed", decision="error")
    scan(store)
    row = client().get(BASE).json()["items"][0]
    assert row["kind"] == "service" and row["action_count"] == 3
    assert "failure" in row["grouping_reason"]


def test_window_and_bounded_batches(store):
    seed(store)
    job(store, at=stamp(-30)); job(store, at=stamp(-10)); job(store)
    assert scan(store, 2) == 2
    assert scan(store, 2) == 1
    assert client().get(BASE).json()["total"] == 0


def test_manual_investigation_notes_resolution_recurrence_and_no_decision_changes(store):
    seed(store)
    evaluation, event = job(store, source="rules"); scan(store)
    c = client(); row = c.get(BASE).json()["items"][0]; url = BASE + "/" + row["id"]
    with store() as db: original = incidents.dump(db.get(SafetyEvaluation, evaluation))
    response = c.patch(url, json={"revision": row["revision"], "status": "investigating"})
    assert response.status_code == 200
    assert c.patch(url, json={"revision": row["revision"], "status": "resolved", "resolution": "expected"}).status_code == 409
    assert c.post(url + "/notes", json={"text": "Expected config check; narrow the rule."}).status_code == 201
    updated = response.json()
    assert c.patch(url, json={"revision": updated["revision"], "status": "resolved"}).status_code == 422
    assert c.patch(url, json={"revision": updated["revision"], "status": "resolved", "resolution": "policy"}).status_code == 200
    assert c.get(BASE).json()["total"] == 0
    assert c.post(url + "/actions", json={"event_id": event}).status_code == 409
    job(store, source="rules", at=stamp(1)); scan(store)
    recurrence = c.get(BASE).json()["items"][0]
    assert recurrence["previous_id"] == row["id"] and recurrence["id"] != row["id"]
    detail = c.get(url).json()
    assert detail["status"] == "resolved" and detail["related"][0]["id"] == recurrence["id"]
    assert any(a["text"].startswith("Expected config") for a in detail["activity"])
    assert c.patch(url, json={"revision": detail["revision"], "status": "investigating"}).status_code == 200
    with store() as db: assert incidents.dump(db.get(SafetyEvaluation, evaluation)) == original


def test_attach_detach_and_delete_connection_cleanup(store, monkeypatch, tmp_path):
    seed(store)
    _, event = job(store)
    _, other = job(store, session="other-connection")
    c = client()
    assert c.post(BASE, json={"event_id": event, "title": " "}).status_code == 422
    row = c.post(BASE, json={"event_id": event, "title": "Check configuration reads"}).json()
    url = BASE + "/" + row["id"]
    assert c.post(url + "/actions", json={"event_id": event}).status_code == 201
    assert c.get(url).json()["action_count"] == 1
    assert c.post(url + "/actions", json={"event_id": other}).status_code == 422
    assert c.get(BASE + f"/for-action/{other}").json()["items"] == []
    detail = c.get(url).json()
    assert c.delete(url + f"/actions/{detail['actions'][0]['link_id']}").status_code == 200
    assert c.get(url).json()["action_count"] == 0
    assert c.post(url + "/notes", json={"text": "   "}).status_code == 422
    monkeypatch.setattr(main.hooks, "queue_path", lambda connection: tmp_path)
    assert c.delete("/api/connections/one").status_code == 200
    assert c.get(url).status_code == 404
    with store() as db:
        assert db.scalar(select(func.count()).select_from(IncidentActivity)) == 0
        assert db.get(Event, other) is not None


def test_list_search_paging_and_empty_detail(store):
    seed(store); _, event = job(store)
    c = client()
    for index in range(23):
        assert c.post(BASE, json={"event_id": event, "title": f"Investigation {index}"}).status_code == 201
    first = c.get(BASE).json(); second = c.get(BASE + "?offset=20").json()
    assert first["total"] == 23 and len(first["items"]) == 20 and len(second["items"]) == 3
    assert c.get(BASE + "?q=Investigation%2022").json()["total"] == 1
    assert c.get(BASE + "?q=%25").json()["total"] == 0
    assert c.get(BASE + "/missing").status_code == 404


def test_initial_monitor_does_not_backfill_old_evaluations(store):
    seed(store); job(store, source="rules")
    with store() as db:
        db.delete(db.get(IncidentMonitor, 1)); db.commit()
    assert scan(store) == 0
    assert scan(store) == 0
    assert client().get(BASE).json()["total"] == 0


def test_late_evidence_keeps_resolution_and_manual_grouping_wins(store):
    seed(store)
    job(store, source="rules", at=stamp(-2)); scan(store)
    c = client(); row = c.get(BASE).json()["items"][0]; url = BASE + "/" + row["id"]
    c.patch(url, json={"revision": row["revision"], "status": "resolved", "resolution": "addressed"})
    job(store, source="rules", at=stamp(-1)); scan(store)
    detail = c.get(url).json()
    assert detail["status"] == "resolved" and detail["action_count"] == 2
    assert any(a["kind"] == "late_evidence" for a in detail["activity"])
    _, event = job(store, source="judge", path="D:/other/key.pem")
    c.post(BASE, json={"event_id": event, "title": "My investigation"}); scan(store)
    assert c.get(BASE).json()["total"] == 1


def test_nearby_suggestions_do_not_merge_distinct_resources(store):
    seed(store)
    job(store, source="rules", path="D:/project/a.pem")
    job(store, source="rules", path="D:/project/b.pem")
    job(store, source="rules", path="D:/project/c.pem", session="other-session")
    scan(store)
    c = client(); rows = c.get(BASE).json()["items"]
    row = next(r for r in rows if r["title"].startswith("a.pem"))
    detail = c.get(BASE + "/" + row["id"]).json()
    assert detail["action_count"] == 1 and len(detail["nearby"]) == 1
    assert detail["nearby"][0]["title"].startswith("b.pem")


def test_resolving_incident_never_releases_pending_approval_or_replaces_evidence(store):
    seed(store)
    evaluation, event = job(store, decision="review", status="awaiting_review")
    c = client()
    row = c.post(BASE, json={"event_id": event, "title": "Check this pending request"}).json()
    with store() as db:
        original = incidents.dump(db.get(SafetyEvaluation, evaluation))
    assert c.patch(BASE + "/" + row["id"], json={"revision": row["revision"], "status": "resolved", "resolution": "expected"}).status_code == 200
    with store() as db:
        assert incidents.dump(db.get(SafetyEvaluation, evaluation)) == original
        replacement = SafetyEvaluation(event_id=event, input_hash="a" * 64, request_key="new-review", mode="shadow", status="completed",
            policy_version="test", model="test", snapshot={"action": "different retrospective evidence"}, rules={}, result={"recommendation": "allow"})
        db.add(replacement); db.commit()
    detail = c.get(BASE + "/" + row["id"]).json()
    assert detail["actions"][0]["evaluation"]["id"] == evaluation
    assert detail["actions"][0]["evaluation"]["status"] == "awaiting_review"
    assert "different retrospective" not in detail["actions"][0]["snapshot"]["action"]


def test_migration_preserves_existing_data_and_round_trips(tmp_path):
    import os
    import sqlite3
    import subprocess
    import sys
    from backend.db import ROOT
    path = tmp_path / "migration.db"
    env = {**os.environ, "DATABASE_URL": "sqlite:///" + path.as_posix()}
    def migrate(*args):
        subprocess.run([sys.executable, "-m", "alembic", *args], cwd=ROOT, env=env, check=True, capture_output=True)
    migrate("upgrade", "0014")
    with sqlite3.connect(path) as db:
        db.execute("INSERT INTO connections (id,name,provider,enabled,status,created_at,hooks_enabled,gate_enabled) VALUES ('saved','Saved source','codex',1,'waiting','2026-09-20',0,0)")
    migrate("upgrade", "head")
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT name FROM connections WHERE id='saved'").fetchone()[0] == "Saved source"
        assert db.execute("SELECT enabled_at FROM incident_monitor WHERE id=1").fetchone()[0]
    migrate("downgrade", "0014")
    migrate("upgrade", "head")
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT count(*) FROM connections").fetchone()[0] == 1
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
