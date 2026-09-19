"""Durable shadow jobs. Ingestion and enqueue commit in the same transaction."""
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
from uuid import uuid4, UUID

from sqlalchemy import select, update, func, or_
from backend.db import Event, SafetyEvaluation, SafetyWorker, SafetyAttempt, now, ROOT
from backend.safety_policy import assess, POLICY_VERSION, MODEL

MAX_PENDING = 1000
MAX_ATTEMPTS = 3
LEASE_SECONDS = 120


def later(seconds):
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


def key_path():
    return Path(os.getenv("RELAY_ANTHROPIC_KEY_FILE", str(ROOT / ".secrets/anthropic.key")))


def read_key():
    # Read afresh so filling the file does not require a worker restart.
    try:
        value = os.getenv("ANTHROPIC_API_KEY") or key_path().read_text(encoding="utf-8-sig").strip()
        return value.strip() if value and value.strip().startswith("sk-ant-") else None
    except OSError:
        return None


def redact(text):
    text = re.sub(r"sk-ant-[A-Za-z0-9_-]+", "[REDACTED_ANTHROPIC_KEY]", text)
    text = re.sub(r"-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----", "[REDACTED_PRIVATE_KEY]", text, flags=re.S)
    return re.sub(r'(?i)(\b(?:api[_-]?key|password|secret|authorization|token)\b["\s:=]+)[^\s,"}]+', r'\1[REDACTED]', text)


def enqueue(db, event, payload, gate=None, request=None):
    request_key = str(UUID(request["id"])) if request else ""
    deadline = None
    if request:
        deadline = datetime.fromisoformat(request["deadline"]).astimezone(timezone.utc).isoformat()
        if deadline > later(65):
            raise ValueError("Gate deadline exceeds the supported waiting period")
    action = {"tool_name": payload["tool_name"], "tool_input": payload.get("tool_input", {}), "cwd": payload.get("cwd")}
    raw = json.dumps(action, sort_keys=True, ensure_ascii=False)
    digest = hashlib.sha256(raw.encode()).hexdigest()
    existing = db.scalar(select(SafetyEvaluation).where(SafetyEvaluation.event_id == event.id, SafetyEvaluation.input_hash == digest, SafetyEvaluation.request_key == request_key))
    if existing:
        if gate and existing.gate is None:
            existing.gate = gate
        return existing
    rules = assess(payload)
    # Context is bounded and frozen at intake; later transcript backfill must not
    # silently change evidence underlying a decision.
    context = list(db.scalars(select(Event).where(Event.session_id == event.session_id,
        Event.id != event.id, Event.occurred_at <= event.occurred_at,
        Event.kind.in_(["message", "tool_call", "tool_result"])).order_by(Event.occurred_at.desc(), Event.id.desc()).limit(8)))
    safe_action = redact(raw)
    snapshot = {"action": safe_action[:24000], "action_truncated": len(safe_action) > 24000,
        "context": [{"event_id": e.id, "role": e.role, "kind": e.kind, "text": redact(e.text)[:1500],
                     "truncated": len(redact(e.text)) > 1500} for e in reversed(context)],
        "context_limitations": "At most 8 preceding local records, 1500 characters each; may be incomplete or lag the live hook. User-role text is evidence, not independently verified authorization."}
    # Keep recent user intent even when many tool records separate it from the action.
    users = list(db.scalars(select(Event).where(Event.session_id == event.session_id, Event.role == "user",
        Event.kind == "message", Event.occurred_at <= event.occurred_at).order_by(Event.occurred_at.desc(), Event.id.desc()).limit(3)))
    snapshot["user_intent"] = [{"source": "recorded_user_message", "event_id": e.id, "text": redact(e.text)[:6000]} for e in reversed(users)]
    # resolve_session already validated this transcript's root and identity.
    from backend.safety_context import recent_messages
    snapshot["live_context"] = recent_messages(payload)
    count = db.scalar(select(func.count()).select_from(SafetyEvaluation).where(SafetyEvaluation.status.in_(["queued", "running"])))
    status = "completed" if rules["decision"] == "deny" else ("skipped" if count >= MAX_PENDING else "queued")
    job = SafetyEvaluation(event_id=event.id, input_hash=digest, policy_version=POLICY_VERSION,
        request_key=request_key, mode="blocking" if request else "shadow", deadline=deadline,
        model=MODEL, snapshot=snapshot, rules=rules, gate=gate, status=status,
        result={"recommendation": "deny", "risk": "high", "reason": "Explicit policy prohibition.",
                "evidence": [f["reason"] for f in rules["findings"]], "missing_context": [], "source": "rules"} if status == "completed" else None,
        error="Queue capacity reached; this action was not evaluated." if status == "skipped" else None,
        completed_at=now() if status in {"completed", "skipped"} else None)
    if request and request.get("requested_at"):
        requested_at = datetime.fromisoformat(request["requested_at"]).astimezone(timezone.utc)
        if not 0 < (datetime.fromisoformat(deadline) - requested_at).total_seconds() <= 60:
            raise ValueError("Invalid request timing")
        job.created_at = requested_at.isoformat()
    if request and status != "queued":
        job.decision = "deny" if status == "completed" else "error"
        job.decision_at = now()
    if request and deadline <= now():
        job.status, job.decision, job.error = "failed", "expired", "Hook deadline expired before intake."
        job.decision_at = job.completed_at = now()
    db.add(job)
    return job


def claim(factory):
    """Atomic compare-and-set claim; works across processes, including SQLite."""
    instant = now()
    with factory() as db:
        expire(db)
        db.execute(update(SafetyEvaluation).where(SafetyEvaluation.status == "running", SafetyEvaluation.lease_until < instant).values(
            status="queued", lease_token=None, lease_until=None, error="Worker lease expired; retrying."))
        db.execute(update(SafetyEvaluation).where(SafetyEvaluation.status == "queued",
            or_(SafetyEvaluation.attempts >= MAX_ATTEMPTS, SafetyEvaluation.created_at < later(-86400))).values(
            status="failed", completed_at=instant, error="Evaluation expired or exhausted its retry budget."))
        db.commit()
        candidate = db.scalar(select(SafetyEvaluation.id).where(SafetyEvaluation.status == "queued",
            SafetyEvaluation.available_at <= instant).order_by((SafetyEvaluation.mode == "blocking").desc(), SafetyEvaluation.deadline, SafetyEvaluation.created_at, SafetyEvaluation.id).limit(1))
        if candidate is None:
            return None
        token = str(uuid4())
        result = db.execute(update(SafetyEvaluation).where(SafetyEvaluation.id == candidate, SafetyEvaluation.status == "queued").values(
            status="running", started_at=instant, lease_token=token, lease_until=later(LEASE_SECONDS), attempts=SafetyEvaluation.attempts + 1))
        if result.rowcount == 1:
            job = db.get(SafetyEvaluation, candidate)
            db.add(SafetyAttempt(id=token, evaluation_id=candidate, number=job.attempts, started_at=instant))
        db.commit()
        return db.get(SafetyEvaluation, candidate) if result.rowcount == 1 else None


def finish(factory, job, *, result=None, error=None, retryable=False, latency_ms=0, usage=None, diagnostics=None):
    retry = error and retryable and job.attempts < MAX_ATTEMPTS
    blocking = job.mode == "blocking"
    if blocking:
        retry = retry and job.attempts < 2 and job.deadline > later(28)
    needs_review = blocking and not error and result.get("recommendation") == "review"
    decision = None if not blocking or retry or needs_review else ("error" if error else "pass" if result.get("recommendation") == "allow" else "deny")
    with factory() as db:
        attempt = db.get(SafetyAttempt, job.lease_token)
        if attempt:
            attempt.completed_at, attempt.error, attempt.diagnostics = now(), error, diagnostics
        expire(db)
        changed = db.execute(update(SafetyEvaluation).where(SafetyEvaluation.id == job.id,
            SafetyEvaluation.status == "running", SafetyEvaluation.lease_token == job.lease_token,
            SafetyEvaluation.lease_until >= now()).values(status="queued" if retry else "failed" if error else "awaiting_review" if needs_review else "completed",
                result=result, error=error, completed_at=None if retry else now(),
                available_at=later(1 if blocking else 30 * job.attempts) if retry else now(), lease_token=None, lease_until=None,
                latency_ms=latency_ms, usage=usage, diagnostics=diagnostics,
                decision=decision, decision_at=now() if decision else None))
        db.commit()
        return changed.rowcount == 1


def public(job):
    return {name: getattr(job, name) for name in ("id", "event_id", "input_hash", "status", "policy_version", "model", "rules", "gate", "result", "error", "attempts", "created_at", "completed_at", "latency_ms", "usage", "mode", "deadline", "started_at", "decision", "decision_at", "returned_at", "diagnostics", "human_decision", "reviewed_at")}


def human_review(db, id_, choice, input_hash):
    """Single atomic decision, tied to the assessed action and live deadline."""
    instant = now()
    if choice not in {"approve", "deny"}:
        return False
    job = db.get(SafetyEvaluation, id_)
    if choice == "approve" and job and job.snapshot.get("action_truncated"):
        return False
    expire(db)
    changed = db.execute(update(SafetyEvaluation).where(
        SafetyEvaluation.id == id_, SafetyEvaluation.input_hash == input_hash,
        SafetyEvaluation.mode == "blocking", SafetyEvaluation.status == "awaiting_review",
        SafetyEvaluation.result["recommendation"].as_string() == "review",
        SafetyEvaluation.rules["decision"].as_string() != "deny",
        SafetyEvaluation.decision.is_(None), SafetyEvaluation.returned_at.is_(None),
        SafetyEvaluation.human_decision.is_(None), SafetyEvaluation.deadline > instant,
    ).values(human_decision=choice, reviewed_at=instant, status="completed",
             decision="pass" if choice == "approve" else "deny", decision_at=instant))
    db.commit()
    return changed.rowcount == 1


def expire(db):
    db.execute(update(SafetyEvaluation).where(SafetyEvaluation.mode == "blocking", SafetyEvaluation.deadline <= now(),
        SafetyEvaluation.returned_at.is_(None), SafetyEvaluation.decision.is_(None)).values(
        status="failed", decision="expired", decision_at=now(), completed_at=now(),
        error="Evaluation deadline exceeded; action remains blocked.", lease_token=None, lease_until=None))


def status(db):
    counts = dict(db.execute(select(SafetyEvaluation.status, func.count()).group_by(SafetyEvaluation.status)).all())
    workers = list(db.scalars(select(SafetyWorker).where(SafetyWorker.heartbeat_at >= later(-30))))
    oldest = db.scalar(select(func.min(SafetyEvaluation.created_at)).where(SafetyEvaluation.status == "queued"))
    return {"mode": "per_connection", "model": MODEL, "policy_version": POLICY_VERSION, "key_configured": bool(read_key()),
        "key_file": str(key_path()), "counts": counts, "oldest_pending_at": oldest,
        "workers": [{"id": w.id, "status": w.status, "heartbeat_at": w.heartbeat_at} for w in workers],
        "max_pending": MAX_PENDING}
