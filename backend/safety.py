"""Durable shadow jobs. Ingestion and enqueue commit in the same transaction."""
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import time
from uuid import uuid4, UUID

from sqlalchemy import select, update, func, or_, case
from backend.db import Event, SafetyEvaluation, SafetyWorker, SafetyAttempt, now, ROOT
from backend.safety_policy import assess, POLICY_VERSION, MODEL

MAX_PENDING = 1000
BLOCKING_RESERVE = 100
MAX_BLOCKING_PER_CONNECTION = 20
from backend.safety_budget import remaining, attempt_timeout, HUMAN_RESERVE, DELIVERY_MARGIN, MIN_ATTEMPT_SECONDS, LEASE_MARGIN
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
    rules_started = time.monotonic()
    rules = assess(payload)
    built_in_deny = rules["decision"] == "deny"
    from backend.policies import evaluate as evaluate_policy
    from backend.db import ChatSession
    connection_id = db.scalar(select(ChatSession.connection_id).where(ChatSession.id == event.session_id))
    from backend.safety_debug import selected_result
    debug_result = selected_result(db) if not built_in_deny else None
    # Debug simulates the decision path, including custom-policy shortcuts.
    if not debug_result:
        rules = evaluate_policy(db, payload, connection_id, rules)
    rules_ms = round((time.monotonic() - rules_started) * 1000)
    # Resolve deterministic policies before context gathering, queuing, or model access.
    policy_match = rules.get("policy", {})
    if not built_in_deny and policy_match.get("decision") in {"allow", "review", "deny"}:
        safe_action = redact(raw)
        if len(safe_action) <= 24000:
            choice = policy_match["decision"]
            stamp = now()
            awaiting = bool(request and choice == "review")
            overloaded = False
            if awaiting:
                owned = db.scalar(select(func.count()).select_from(SafetyEvaluation).join(Event).join(ChatSession).where(
                    ChatSession.connection_id == connection_id, SafetyEvaluation.mode == "blocking",
                    SafetyEvaluation.status.in_(["queued", "running", "awaiting_review"])))
                overloaded = owned >= MAX_BLOCKING_PER_CONNECTION
            job = SafetyEvaluation(event_id=event.id, input_hash=digest, request_key=request_key,
                mode="blocking" if request else "shadow", deadline=deadline,
                policy_version=f"{POLICY_VERSION}:p{policy_match['version']}", model="policy",
                rules=rules, gate=gate, status="awaiting_review" if awaiting else "completed",
                snapshot={"action": safe_action, "action_truncated": False, "context": [], "context_limitations": "Deterministic policy; no model context collected."},
                result={"recommendation": choice, "risk": "unknown" if choice == "review" else "high" if choice == "deny" else "low", "suspicious": False,
                        "severity": "high" if choice in {"review", "deny"} else "low", "reason": policy_match["reason"],
                        "evidence": [f"Policy version {policy_match['version']}"], "missing_context": [], "source": "policy"},
                admitted_at=stamp, rules_ms=rules_ms, completed_at=stamp, review_ready_at=stamp if awaiting else None,
                decision=None if not request or awaiting else "pass" if choice == "allow" else "deny",
                decision_at=stamp if request and not awaiting else None)
            if request and request.get("requested_at"):
                requested_at = datetime.fromisoformat(request["requested_at"]).astimezone(timezone.utc)
                if not 0 < (datetime.fromisoformat(deadline) - requested_at).total_seconds() <= 60:
                    raise ValueError("Invalid request timing")
                job.created_at = requested_at.isoformat()
            if request and deadline <= stamp:
                job.status, job.decision, job.error, job.decision_at = "failed", "expired", "Hook deadline expired before intake.", stamp
            if overloaded:
                job.status, job.decision, job.error, job.decision_at = "skipped", "error", "Connection review capacity reached; action remains blocked.", stamp
                job.review_ready_at = None
            db.add(job)
            return job
        rules["decision"] = "review"
        rules["policy"] = {**policy_match, "decision": "none", "reason": "Action is incomplete; judge required."}
    if not built_in_deny:
        from backend.threats import triage
        rules["triage"] = triage(payload)
        if rules.get("policy", {}).get("decision") == "judge":
            rules["triage"]["reason"] = "The applied rule requires a judge assessment."
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
    from backend.db import ChatSession
    saturated = count >= (MAX_PENDING if request else max(0, MAX_PENDING - BLOCKING_RESERVE))
    if request:
        connection_id = db.scalar(select(ChatSession.connection_id).where(ChatSession.id == event.session_id))
        owned = db.scalar(select(func.count()).select_from(SafetyEvaluation).join(Event).join(ChatSession).where(
            ChatSession.connection_id == connection_id, SafetyEvaluation.mode == "blocking",
            SafetyEvaluation.status.in_(["queued", "running", "awaiting_review"])))
        saturated = saturated or owned >= MAX_BLOCKING_PER_CONNECTION
    status = "completed" if rules["decision"] == "deny" else ("skipped" if saturated else "queued")
    job = SafetyEvaluation(event_id=event.id, input_hash=digest, policy_version=POLICY_VERSION,
        request_key=request_key, mode="blocking" if request else "shadow", deadline=deadline,
        model="debug" if debug_result else MODEL, debug_result=debug_result,
        snapshot=snapshot, rules=rules, gate=gate, status=status,
        admitted_at=now(), rules_ms=rules_ms,
        result={"recommendation": "deny", "risk": "high", "suspicious": False, "severity": "high", "reason": "Explicit policy prohibition.",
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


def claim(factory, blocking_only=False, debug_only=False):
    """Atomic compare-and-set claim; works across processes, including SQLite."""
    instant = now()
    with factory() as db:
        expire(db)
        abandoned = select(SafetyEvaluation.lease_token).where(SafetyEvaluation.status == "running", SafetyEvaluation.lease_until < instant)
        db.execute(update(SafetyAttempt).where(SafetyAttempt.id.in_(abandoned), SafetyAttempt.completed_at.is_(None)).values(
            completed_at=instant, error="Worker lease expired before completion."))
        db.execute(update(SafetyEvaluation).where(SafetyEvaluation.status == "running", SafetyEvaluation.lease_until < instant).values(
            status="queued", lease_token=None, lease_until=None, error="Worker lease expired; retrying."))
        db.execute(update(SafetyEvaluation).where(SafetyEvaluation.status == "queued",
            or_(SafetyEvaluation.attempts >= case((SafetyEvaluation.mode == "blocking", 2), else_=MAX_ATTEMPTS), SafetyEvaluation.created_at < later(-86400))).values(
            status="failed", completed_at=instant,
            decision=case((SafetyEvaluation.mode == "blocking", "error"), else_=None),
            decision_at=case((SafetyEvaluation.mode == "blocking", instant), else_=None),
            error="Evaluation expired or exhausted its retry budget."))
        db.commit()
        db.execute(update(SafetyEvaluation).where(SafetyEvaluation.mode == "blocking", SafetyEvaluation.status == "queued",
            SafetyEvaluation.deadline <= later(HUMAN_RESERVE + DELIVERY_MARGIN + MIN_ATTEMPT_SECONDS)).values(
            status="failed", decision="error", decision_at=instant, completed_at=instant,
            error="Automated evaluation budget exhausted; action remains blocked."))
        db.commit()
        candidate = db.scalar(select(SafetyEvaluation.id).where(SafetyEvaluation.status == "queued",
            *([SafetyEvaluation.mode == "blocking"] if blocking_only else []),
            *([SafetyEvaluation.debug_result.is_not(None)] if debug_only else []),
            SafetyEvaluation.available_at <= instant).order_by((SafetyEvaluation.mode == "blocking").desc(), SafetyEvaluation.deadline, SafetyEvaluation.created_at, SafetyEvaluation.id).limit(1))
        if candidate is None:
            return None
        candidate_job = db.get(SafetyEvaluation, candidate)
        lease = attempt_timeout(candidate_job) + LEASE_MARGIN if candidate_job.mode == "blocking" else LEASE_SECONDS
        token = str(uuid4())
        result = db.execute(update(SafetyEvaluation).where(SafetyEvaluation.id == candidate, SafetyEvaluation.status == "queued").values(
            status="running", started_at=instant, lease_token=token, lease_until=later(lease), first_started_at=func.coalesce(SafetyEvaluation.first_started_at, instant), attempts=SafetyEvaluation.attempts + 1))
        if result.rowcount == 1:
            job = db.get(SafetyEvaluation, candidate)
            db.add(SafetyAttempt(id=token, evaluation_id=candidate, number=job.attempts, started_at=instant))
        db.commit()
        return db.get(SafetyEvaluation, candidate) if result.rowcount == 1 else None


def finish(factory, job, *, result=None, error=None, retryable=False, latency_ms=0, usage=None, diagnostics=None):
    # Keep the floor even for debug verdicts and alternate in-process evaluators.
    if result:
        result = dict(result)
        result.setdefault("suspicious", False)
        result.setdefault("severity", result.get("risk") if result.get("risk") in {"low", "medium", "high", "critical"} else "medium")
        if result.get("recommendation") in {"review", "deny"} and result["severity"] in {"low", "medium"}:
            result["severity"] = "high"
    retry = error and retryable and job.attempts < MAX_ATTEMPTS
    blocking = job.mode == "blocking"
    if blocking:
        retry = retry and job.attempts < 2 and remaining(job) > MIN_ATTEMPT_SECONDS + 1
        if remaining(job) <= 0:
            result, error, retry = None, "Automated evaluation budget exhausted; action remains blocked.", False
    needs_review = blocking and not error and result.get("recommendation") == "review"
    decision = None if not blocking or retry or needs_review else ("error" if error else "pass" if result.get("recommendation") == "allow" else "deny")
    with factory() as db:
        attempt = db.get(SafetyAttempt, job.lease_token)
        if attempt:
            attempt.completed_at, attempt.error, attempt.diagnostics = now(), error, diagnostics
            attempt.latency_ms, attempt.usage = latency_ms, usage
        expire(db)
        changed = db.execute(update(SafetyEvaluation).where(SafetyEvaluation.id == job.id,
            SafetyEvaluation.status == "running", SafetyEvaluation.lease_token == job.lease_token,
            SafetyEvaluation.lease_until >= now()).values(status="queued" if retry else "failed" if error else "awaiting_review" if needs_review else "completed",
                result=result, error=error, completed_at=None if retry else now(),
                available_at=later(1 if blocking else 30 * job.attempts) if retry else now(), lease_token=None, lease_until=None,
                latency_ms=latency_ms, usage=usage, diagnostics=diagnostics,
                review_ready_at=now() if needs_review else None,
                decision=decision, decision_at=now() if decision else None))
        db.commit()
        return changed.rowcount == 1


def public(job):
    return {name: getattr(job, name) for name in ("id", "event_id", "request_key", "input_hash", "debug_result", "status", "policy_version", "model", "rules", "gate", "result", "error", "attempts", "created_at", "completed_at", "latency_ms", "usage", "mode", "deadline", "started_at", "decision", "decision_at", "returned_at", "diagnostics", "human_decision", "reviewed_at", "admitted_at", "first_started_at", "review_ready_at", "published_at", "rules_ms")}


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
    db.execute(update(SafetyEvaluation).where(SafetyEvaluation.mode == "blocking",
        SafetyEvaluation.status.in_(["queued", "running"]), SafetyEvaluation.decision.is_(None),
        SafetyEvaluation.deadline > now(), SafetyEvaluation.deadline <= later(HUMAN_RESERVE + DELIVERY_MARGIN)).values(
        status="failed", decision="error", decision_at=now(), completed_at=now(),
        error="Automated evaluation budget exhausted; action remains blocked.", lease_token=None, lease_until=None))
    db.execute(update(SafetyEvaluation).where(SafetyEvaluation.mode == "blocking", SafetyEvaluation.deadline <= now(),
        SafetyEvaluation.returned_at.is_(None), SafetyEvaluation.decision.is_(None)).values(
        status="failed", decision="expired", decision_at=now(), completed_at=now(),
        error="Evaluation deadline exceeded; action remains blocked.", lease_token=None, lease_until=None))


def status(db):
    from backend.safety_metrics import summary
    from backend.safety_debug import settings
    counts = dict(db.execute(select(SafetyEvaluation.status, func.count()).group_by(SafetyEvaluation.status)).all())
    workers = list(db.scalars(select(SafetyWorker).where(SafetyWorker.heartbeat_at >= later(-30))))
    oldest = db.scalar(select(func.min(SafetyEvaluation.created_at)).where(SafetyEvaluation.status == "queued"))
    return {"mode": "per_connection", "model": MODEL, "policy_version": POLICY_VERSION, "key_configured": bool(read_key()),
        "key_file": str(key_path()), "counts": counts, "oldest_pending_at": oldest,
        "workers": [{"id": w.id, "status": w.status, "heartbeat_at": w.heartbeat_at} for w in workers],
        "max_pending": MAX_PENDING, "performance": summary(db), "debug": settings(db),
        "capacity": {"blocking_reserved": BLOCKING_RESERVE, "per_connection": MAX_BLOCKING_PER_CONNECTION,
                     "human_reserve_seconds": HUMAN_RESERVE, "attempt_seconds": 10}}
