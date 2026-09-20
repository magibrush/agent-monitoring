"""Deterministic attention data for the isolated browser-test database only."""
import json
import os
import sys
from itertools import count
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
os.environ["DATABASE_URL"] = "sqlite:///" + (ROOT / "data/e2e.db").as_posix()

from backend.db import (engine, SessionLocal, Connection, ChatSession, Event,
    SafetyEvaluation, PolicyVersion, PolicyState, PolicyChange, now)
from backend.policies import PolicyRule
from backend.incidents import correlate, Incident
from sqlalchemy import select, delete

assert str(engine.url).endswith("/data/e2e.db")
with SessionLocal() as db:
    if len(sys.argv) > 1 and sys.argv[1] == "cleanup":
        saved = json.loads(sys.argv[2])
        state = db.get(PolicyState, 1)
        for field, value in saved["policy"].items(): setattr(state, field, value)
        state.revision += 1
        db.flush()
        db.execute(delete(PolicyChange).where(PolicyChange.version_id.not_in(saved["versions"])))
        db.execute(delete(PolicyVersion).where(PolicyVersion.id.not_in(saved["versions"])))
        db.commit()
        sys.exit(0)
    state = db.get(PolicyState, 1)
    previous = {field: getattr(state, field) if state else None for field in ("active_id", "draft_id", "paused_id", "trial_id")}
    versions = list(db.scalars(select(PolicyVersion.id)))
    connection = Connection(name="Attention browser fixture", provider="claude_code", path="", enabled=False)
    db.add(connection); db.flush()
    session = ChatSession(connection_id=connection.id, external_id="attention-browser", title="Update the project docs", source="test", created_at=now(), updated_at=now())
    db.add(session); db.flush()
    rule = PolicyRule(id="attention-docs", name="Review documentation reads", activity="read", effect="review", connection_ids=[connection.id]).model_dump()
    version = PolicyVersion(name="Attention fixture", rules=[rule])
    db.add(version); db.flush()
    state = db.get(PolicyState, 1)
    if not state:
        state = PolicyState(id=1); db.add(state); db.flush()
    state.active_id = version.id; state.paused_id = None; state.draft_id = None; state.revision += 1
    service = len(sys.argv) > 1 and sys.argv[1] == "service"
    legacy = len(sys.argv) > 1 and sys.argv[1] == "policy"
    event_numbers = count()
    def event(kind, role, text, tool="", hook_state=None):
        # Windows clocks can return the same timestamp for successive inserts.
        value = Event(session_id=session.id, external_id=f"attention-{next(event_numbers)}", kind=kind, role=role, text=text, tool_name=tool, occurred_at=now(), payload={}, hook_state=hook_state)
        db.add(value); db.flush(); return value
    goal = event("message", "user", "Update the documentation on docs-refresh. You can replace my own branch commits, but leave main alone.")
    event("message", "assistant", "I'll update the guide and push the docs-refresh branch.")
    event("tool_call", "assistant", '{"tool_name":"Read","tool_input":{"file_path":"D:/fictional-project/guide.md"}}', "Read", "succeeded")
    event("tool_result", "tool", "The guide still points to the old installation command.")
    flagged_ids = []
    for i in range(3 if service or legacy else 1):
        payload = json.dumps({"tool_name": "Read" if legacy else "exec_command", "tool_input": {"file_path": f"D:/fictional-project/guide-{i}.md"} if legacy else {"command": "git push --force-with-lease origin docs-refresh"}, "cwd": "D:/fictional-project"})
        action = event("tool_call", "assistant", payload, "Read" if legacy else "exec_command", "failed" if not legacy and not service else "requested")
        flagged_ids.append(action.id)
        db.add(SafetyEvaluation(event_id=action.id, input_hash=str(i)*64, request_key=f"attention-{i}", mode="blocking", status="failed" if service else "completed", created_at=now(), policy_version="test", model="policy" if legacy else "claude-haiku-4-5-20251001", snapshot={"action": payload, "action_truncated": False, "user_intent": [{"event_id": goal.id, "text": goal.text}]}, rules={"findings": [], "policy": {"version": version.id, "rule_ids": [rule["id"]]} if legacy else {}, "triage": {"route": "judge", "signals": [{"category": "history_rewrite", "severity": "high", "reason": "Force push can replace remote history."}]}}, result={"source": "policy" if legacy else "judge", "recommendation": "deny" if legacy else "allow", "risk": "high" if legacy else "medium", "severity": "high" if legacy else "medium", "suspicious": not legacy and not service, "reason": rule["name"] if legacy else "The task permits updating this branch, but a force push can replace commits made by collaborators.", "evidence": [], "missing_context": []}, decision="error" if service else "deny" if legacy else "pass", deadline=(datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat(), returned_at=now(), gate={"decision": "error" if service else "deny" if legacy else "pass", "policy_version": "test"}))
    outcome = event("tool_result", "tool", "Git rejected the push: stale info. The remote branch was not updated.")
    event("message", "assistant", "The remote branch changed. I'll fetch it and inspect the difference before trying again.")
    db.commit()
    correlate(db)
    row = db.scalar(select(Incident).where(Incident.connection_id == connection.id))
    if not service and not legacy:
        from backend.incident_analysis import evidence_bundle
        from backend.db import IncidentAnalysis
        bundle = evidence_bundle(db, row)
        result = {"summary": "The agent updated documentation and attempted a force push to docs-refresh, as the user permitted. The judge allowed the request but flagged the risk of replacing someone else's commits. Relay released it; Git then rejected the push because the remote had changed.",
            "findings": [{"text": "No successful remote update is recorded. The tool result reports a stale-info rejection.", "evidence_ids": [flagged_ids[0], outcome.id]}],
            "recommendations": [{"text": "Fetch the current branch and compare the remote commits before another push. Keep --force-with-lease so a later remote change causes another rejection.", "evidence_ids": [goal.id, flagged_ids[0], outcome.id]}]}
        db.add(IncidentAnalysis(incident_id=row.id, requested_revision=row.revision, analyzed_revision=row.revision, status="ready", evidence=bundle, result=result, analyzed_at=now(), available_at=now(), model="claude-haiku-4-5-20251001", attempts=1)); db.commit()
    print(json.dumps({"incident": row.id, "connection": connection.id, "policy": previous, "versions": versions}))
