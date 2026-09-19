"""Publish committed decisions to waiting hooks; consume delivery receipts."""
import json
from uuid import UUID

from sqlalchemy import select
from backend.db import SafetyEvaluation, Event, ChatSession, Connection, now
from backend.hooks import queue_path
from backend.safety import expire


def dispatch(db):
    expire(db)
    jobs = db.execute(select(SafetyEvaluation, Connection).join(Event, SafetyEvaluation.event_id == Event.id)
        .join(ChatSession, Event.session_id == ChatSession.id).join(Connection, ChatSession.connection_id == Connection.id)
        .where(SafetyEvaluation.mode == "blocking", SafetyEvaluation.returned_at.is_(None)).order_by(SafetyEvaluation.created_at.desc()).limit(1000)).all()
    for job, connection in jobs:
        queue = queue_path(connection)
        receipt_path = queue / "receipts" / (job.request_key + ".json")
        if receipt_path.is_file():
            try:
                if receipt_path.stat().st_size > 16000:
                    raise ValueError("Oversized receipt")
                record = json.loads(receipt_path.read_text(encoding="utf-8"))
                if str(UUID(record["id"])) != job.request_key or record["input_hash"] != job.input_hash:
                    raise ValueError("Mismatched receipt")
                decision = record["decision"]
                if decision not in {"pass", "deny", "error", "expired"}:
                    raise ValueError("Invalid receipt")
                if decision == "pass" and (job.decision != "pass" or record["returned_at"] > job.deadline):
                    raise ValueError("Invalid release receipt")
                job.gate = {"decision": decision, "policy_version": job.policy_version}
                job.returned_at = record["returned_at"]
                if decision in {"expired", "error"}:
                    job.decision = decision
                    job.error = "Hook could not release the action before its deadline." if decision == "expired" else "Hook failed to accept the decision."
                db.commit()
                receipt_path.unlink(missing_ok=True)
                (queue / "replies" / (job.request_key + ".json")).unlink(missing_ok=True)
            except (OSError, ValueError, KeyError, TypeError):
                # Do not turn malformed acknowledgments into a release.
                continue
        elif job.decision:
            directory = queue / "replies"
            directory.mkdir(parents=True, exist_ok=True)
            target = directory / (job.request_key + ".json")
            if target.exists():
                continue
            db.commit()  # A hook must never observe an uncommitted authorization.
            pending = target.with_suffix(".tmp")
            pending.write_text(json.dumps({"id": job.request_key, "input_hash": job.input_hash,
                "deadline": job.deadline, "decision": job.decision}), encoding="utf-8")
            pending.replace(target)
    db.commit()
