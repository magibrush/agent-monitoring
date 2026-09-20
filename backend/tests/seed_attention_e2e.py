"""Deterministic attention data for the isolated browser-test database only."""
import json
import os
import sys
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
    for i in range(3):
        payload = json.dumps({"tool_name": "Read", "tool_input": {"file_path": f"D:/fictional-project/guide-{i}.md"}, "cwd": "D:/fictional-project"})
        event = Event(session_id=session.id, external_id=f"attention-{i}", kind="tool_call", role="assistant", text=payload, tool_name="Read", occurred_at=now(), payload={})
        db.add(event); db.flush()
        db.add(SafetyEvaluation(event_id=event.id, input_hash=str(i)*64, request_key=f"attention-{i}", mode="blocking", status="failed" if service else "completed", created_at=now(), policy_version="test", model="policy", snapshot={"action": payload}, rules={"findings": [], "policy": {"version": version.id, "rule_ids": [rule["id"]]}}, result={"source": "judge" if service else "policy", "recommendation": "review", "risk": "unknown", "reason": rule["name"], "evidence": [], "missing_context": []}, decision="error" if service else "allow", human_decision=None if service else "approve", review_ready_at=None if service else now(), deadline=(datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat(), returned_at=now(), gate={"decision": "error" if service else "pass", "policy_version": "test"}))
    db.commit()
    correlate(db)
    row = db.scalar(select(Incident).where(Incident.connection_id == connection.id))
    print(json.dumps({"incident": row.id, "connection": connection.id, "policy": previous, "versions": versions}))
