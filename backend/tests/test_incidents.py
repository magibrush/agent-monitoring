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


def job(store, source="policy", session="session", path="D:/project/.env", at=None, status="completed", decision="deny", debug=None, retry=False, mode="blocking", risk="high", suspicious=False, severity=None):
    with store() as db:
        action = json.dumps({"tool_name": "Read", "tool_input": {"file_path": path}, "cwd": "D:/project"})
        event = Event(session_id=session, external_id=now(), kind="tool_call", role="assistant", text=action, tool_name="Read", occurred_at=at or now(), payload={}, hook_state="requested")
        db.add(event); db.flush()
        row = SafetyEvaluation(event_id=event.id, input_hash=hashlib.sha256(action.encode()).hexdigest(), request_key=now(), mode=mode, status=status, created_at=at or now(),
            policy_version="test", model="test", snapshot={"action": action, "context": []}, debug_result=debug,
            rules={"findings": [{"id": "credential", "reason": "Protected file"}], "policy": {"rule_ids": ["env"], "version": 1, "reason": "Private configuration"}},
            result={"risk": risk, "severity": severity or risk, "suspicious": suspicious, "source": source, "recommendation": decision, "reason": "Private configuration read", "evidence": [], "missing_context": []},
            diagnostics={"retry_of": "original"} if retry else None, decision=decision)
        db.add(row); db.commit()
        return row.id, event.id


def scan(store, limit=100):
    with store() as db: return incidents.correlate(db, limit)


def client():
    return TestClient(main.app, base_url="http://localhost")


def test_threshold_scope_and_restart_idempotency(store):
    seed(store)
    ids = [job(store, source="rules") for _ in range(2)]
    assert scan(store) == 2
    assert client().get(BASE).json()["total"] == 0
    ids.append(job(store, source="rules")); scan(store)
    listing = client().get(BASE).json()
    assert listing["total"] == 1 and listing["items"][0]["action_count"] == 3
    job(store, source="rules", session="other-session"); job(store, source="rules", session="other-connection"); job(store, source="rules", path="D:/elsewhere/.env")
    scan(store)
    assert scan(store) == 0
    assert client().get(BASE).json()["items"][0]["action_count"] == 3
    detail = client().get(BASE + "/" + listing["items"][0]["id"]).json()
    assert len(detail["actions"]) == 3 and "same file" in detail["grouping_reason"]
    assert {a["evaluation"]["id"] for a in detail["actions"]} == {i[0] for i in ids}


def test_immediate_concerns_exclusions_and_delayed_completion(store):
    seed(store)
    job(store, source="rules", mode="shadow")
    job(store, source="judge", mode="shadow", path="D:/other/key.pem")
    job(store, source="judge", mode="shadow", debug="deny")
    job(store, source="judge", mode="shadow", retry=True)
    job(store, source="judge", mode="shadow", at=stamp(-120))
    waiting, _ = job(store, source="judge", mode="shadow", status="running")
    job(store, decision="review", status="awaiting_review")
    scan(store)
    assert client().get(BASE).json()["total"] == 2
    with store() as db:
        db.get(SafetyEvaluation, waiting).status = "completed"; db.commit()
    assert scan(store) == 1
    assert client().get(BASE).json()["total"] == 2
    assert sum(r["action_count"] for r in client().get(BASE).json()["items"]) == 3


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
    evaluation, event = job(store, source="rules", mode="shadow"); scan(store)
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
    job(store, source="rules", mode="shadow", at=stamp(1)); scan(store)
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
    seed(store); job(store, source="rules", mode="shadow")
    with store() as db:
        db.delete(db.get(IncidentMonitor, 1)); db.commit()
    assert scan(store) == 0
    assert scan(store) == 0
    assert client().get(BASE).json()["total"] == 0


def test_late_evidence_keeps_resolution_and_manual_grouping_wins(store):
    seed(store)
    job(store, source="rules", mode="shadow", at=stamp(-2)); scan(store)
    c = client(); row = c.get(BASE).json()["items"][0]; url = BASE + "/" + row["id"]
    c.patch(url, json={"revision": row["revision"], "status": "resolved", "resolution": "addressed"})
    job(store, source="rules", mode="shadow", at=stamp(-1)); scan(store)
    detail = c.get(url).json()
    assert detail["status"] == "resolved" and detail["action_count"] == 2
    assert any(a["kind"] == "late_evidence" for a in detail["activity"])
    _, event = job(store, source="judge", mode="shadow", path="D:/other/key.pem")
    c.post(BASE, json={"event_id": event, "title": "My investigation"}); scan(store)
    assert c.get(BASE).json()["total"] == 1


def test_nearby_suggestions_do_not_merge_distinct_resources(store):
    seed(store)
    job(store, source="rules", mode="shadow", path="D:/project/a.pem")
    job(store, source="rules", mode="shadow", path="D:/project/b.pem")
    job(store, source="rules", mode="shadow", path="D:/project/c.pem", session="other-session")
    scan(store)
    c = client(); rows = c.get(BASE).json()["items"]
    row = next(r for r in rows if "a.pem" in r["title"])
    detail = c.get(BASE + "/" + row["id"]).json()
    assert detail["action_count"] == 1 and len(detail["nearby"]) == 1
    assert "b.pem" in detail["nearby"][0]["title"]


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
    # Existing linked assessments retain their importance through the analysis upgrade.
    from backend.db import make_engine
    from sqlalchemy.orm import sessionmaker
    fixture_engine = make_engine(env["DATABASE_URL"])
    with sessionmaker(fixture_engine)() as db:
        session = ChatSession(connection_id="saved", external_id="migration", title="Saved conversation", source="test", created_at=now(), updated_at=now())
        db.add(session); db.flush()
        event = Event(session_id=session.id, external_id="migration", kind="tool_call", role="assistant", text="saved request", tool_name="Read", occurred_at=now(), payload={})
        db.add(event); db.flush()
        evaluation = SafetyEvaluation(event_id=event.id, input_hash="a" * 64, policy_version="old", model="old", rules={}, snapshot={}, status="completed", result={"recommendation": "review", "risk": "unknown"})
        incident = Incident(connection_id="saved", title="Saved concern", grouping_reason="Legacy evidence", severity="low")
        db.add_all([evaluation, incident]); db.flush()
        incident_id = incident.id
        db.add(IncidentLink(incident_id=incident.id, event_id=event.id, evaluation_id=evaluation.id, source="automatic")); db.commit()
    fixture_engine.dispose()
    migrate("downgrade", "0015")
    migrate("upgrade", "head")
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT severity FROM incidents WHERE id=?", (incident_id,)).fetchone()[0] == "high"
        assert db.execute("SELECT count(*) FROM incident_links WHERE incident_id=?", (incident_id,)).fetchone()[0] == 1
    migrate("downgrade", "0014")
    migrate("upgrade", "head")
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT count(*) FROM connections").fetchone()[0] == 1
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_prevented_single_is_quiet_and_dismissed_pattern_returns_in_place(store):
    seed(store)
    job(store, source="rules", mode="blocking"); scan(store)
    assert client().get(BASE).json()["total"] == 0
    for _ in range(3): job(store, decision="deny", status="completed")
    scan(store)
    c = client(); row = c.get(BASE).json()["items"][0]; url = BASE + "/" + row["id"]
    assert "were blocked" in row["headline"]
    assert c.patch(url, json={"revision": row["revision"], "status": "resolved", "resolution": "dismissed"}).status_code == 200
    for _ in range(2): job(store, decision="deny", status="completed", at=stamp(1))
    scan(store)
    assert c.get(BASE).json()["total"] == 0
    job(store, decision="deny", status="completed", at=stamp(2)); scan(store)
    returned = c.get(BASE).json()["items"][0]
    assert returned["id"] == row["id"] and returned["action_count"] == 6
    assert returned["resurfaced"] == "Shown again after 3 new matching requests."
    job(store, decision="deny", status="completed", at=stamp(30)); scan(store)
    assert c.get(BASE).json()["items"][0]["action_count"] == 7


def test_rule_bridge_focused_preview_and_observed_followup(store):
    from backend.policies import PolicyRule
    from backend.db import PolicyVersion, PolicyState, PolicyChange
    seed(store)
    original = PolicyRule(id="env", name="Review file reads", activity="read", effect="review").model_dump()
    with store() as db:
        db.add(PolicyVersion(id=1, name="Original", rules=[original])); db.flush()
        db.add(PolicyState(id=1, active_id=1, revision=1)); db.commit()
    ids = [job(store, session="session" if i == 0 else "other-session", path=f"D:/project/readme{i}.md", decision="review", status="awaiting_review") for i in range(3)]
    scan(store)
    c = client()
    assert c.get(BASE).json()["total"] == 0  # Routine policy reviews don't create extra tasks.
    row = c.post(BASE, json={"event_id": ids[0][1], "title": "Review file reads"}).json()
    url = BASE + "/" + row["id"]
    for _, event in ids[1:]: c.post(url + "/actions", json={"event_id": event})
    row = c.get(url).json()
    assert row["rule"]["id"] == "env" and row["next_step"] == "rule"
    assert row["session_count"] == 2 and row["action_count"] == 3
    assert c.get(BASE + "?q=Review%20file%20reads").json()["total"] == 1
    assert c.post(url + "/preview", json={"revision": 1}).status_code == 409
    changed = {**original, "effect": "judge"}
    with store() as db:
        db.add(PolicyVersion(id=2, name="Draft", rules=[changed])); db.flush()
        state = db.get(PolicyState, 1); state.draft_id = 2; state.revision = 2
        broken = db.get(SafetyEvaluation, ids[0][0]); broken.snapshot = {"action": "{}", "action_truncated": True}
        db.commit()
    assert c.post(url + "/preview", json={"revision": 1}).status_code == 409
    preview = c.post(url + "/preview", json={"revision": 2})
    assert preview.status_code == 200, preview.text
    assert preview.json()["counts"]["judge"] == 2 and preview.json()["counts"]["unavailable"] == 1
    with store() as db:
        assert db.get(PolicyVersion, 2).previewed_at is None
        state = db.get(PolicyState, 1); state.draft_id = None; state.active_id = 2
        db.add(PolicyChange(action="activate", version_id=2, created_at=stamp(-1))); db.commit()
    detail = c.get(url).json()
    assert detail["followup"]["changed"] and detail["followup"]["triggered"] == 3
    with store() as db:
        for evaluation, _ in ids:
            job_ = db.get(SafetyEvaluation, evaluation)
            job_.rules = {"policy": {"rule_ids": ["env"], "version": 2}}
            job_.result = {"source": "policy", "recommendation": "judge"}
        db.commit()
    # A prior immutable rule snapshot is the basis of the follow-up.
    with store() as db:
        incident = db.get(Incident, row["id"])
        followup = incidents.followup(db, incident, row["rule"])
        assert followup["triggered"] == 0 and followup["assessed"] == 3


def test_suspicious_allow_is_immediate_low_severity_and_receipt_is_separate(store):
    seed(store)
    evaluation, event = job(store, source="judge", decision="allow", suspicious=True, severity="low", risk="low")
    scan(store)
    c = client(); row = c.get(BASE).json()["items"][0]
    assert row["severity"] == "low" and row["suspicious"] and row["allowed_flagged"] == 1
    assert row["released"] == 0 and row["headline"] == "Allowed by the judge, flagged"
    url = BASE + "/" + row["id"]
    with store() as db:
        before = incidents.dump(db.get(SafetyEvaluation, evaluation))
    c.patch(url, json={"revision": row["revision"], "status": "resolved", "resolution": "dismissed"})
    job(store, source="judge", decision="allow", suspicious=True, severity="critical", at=stamp(1)); scan(store)
    shown = c.get(BASE).json()["items"][0]
    assert shown["id"] == row["id"] and shown["severity"] == "critical"
    assert "New suspicious" in shown["resurfaced"]
    with store() as db: assert incidents.dump(db.get(SafetyEvaluation, evaluation)) == before
    detail = c.get(url).json()
    assert detail["timeline"]["events"] and detail["analysis"]["status"] == "unavailable"


def test_judge_reviews_high_floor_severity_order_across_conversations(store):
    seed(store)
    low, _ = job(store, source="judge", session="other-session", decision="allow", suspicious=True, severity="low", risk="low")
    high, _ = job(store, source="judge", decision="review", status="awaiting_review", severity="low", risk="low")
    with store() as db:
        db.get(SafetyEvaluation, low).rules = {"triage": {"signals": [{"category": "history_rewrite"}]}}
        db.get(SafetyEvaluation, high).rules = {"triage": {"signals": [{"category": "credential_access"}]}}
        db.commit()
    scan(store)
    rows = client().get(BASE).json()["items"]
    assert len(rows) == 2 and [r["severity"] for r in rows] == ["high", "low"]
    assert client().get(BASE + "?severity=low").json()["total"] == 1


def test_judge_concerns_group_across_tools_and_categories_by_conversation(store):
    seed(store)
    ids = []
    for tool, category, severity in (("Bash", None, "high"), ("Read", None, "high"),
                                     ("Glob", None, "critical"), ("Write", "credential_access", "high"),
                                     ("Bash", "history_rewrite", "high")):
        evaluation, event = job(store, source="judge", suspicious=True, severity=severity)
        with store() as db:
            db.get(Event, event).tool_name = tool
            row = db.get(SafetyEvaluation, evaluation)
            action = json.loads(row.snapshot["action"])
            action["tool_name"] = tool
            row.snapshot = {**row.snapshot, "action": json.dumps(action)}
            row.rules = {"triage": {"signals": [{"category": category}] if category else []}}
            db.commit()
        ids.append(evaluation)
        scan(store)
    rows = client().get(BASE).json()["items"]
    assert len(rows) == 1
    assert rows[0]["action_count"] == 5 and rows[0]["severity"] == "critical"
    detail = client().get(BASE + "/" + rows[0]["id"]).json()
    assert {a["evaluation"]["id"] for a in detail["actions"]} == set(ids)
    job(store, source="judge", session="other-session")
    job(store, source="judge", session="other-connection")
    scan(store)
    assert client().get(BASE).json()["total"] == 3
    assert scan(store) == 0
