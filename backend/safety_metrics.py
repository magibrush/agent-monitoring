"""Bounded local operational metrics. No action contents or secrets in labels."""
import math
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from sqlalchemy import select, func
from backend.db import SafetyEvaluation, SafetyAttempt


def duration(start, end):
    if not start or not end:
        return None
    return max(0, round((datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds() * 1000))


def timings(job, attempts):
    complete = [a.latency_ms for a in attempts if a.latency_ms is not None]
    return {
        "intake_ms": duration(job.created_at, job.admitted_at),
        "rules_ms": job.rules_ms,
        "queue_ms": duration(job.admitted_at, job.first_started_at),
        "model_ms": sum(complete) if attempts and len(complete) == len(attempts) else None,
        "human_ms": duration(job.review_ready_at, job.reviewed_at),
        "publication_ms": duration(job.decision_at, job.published_at),
        "delivery_ms": duration(job.published_at, job.returned_at),
        "pause_ms": duration(job.created_at, job.returned_at) if job.mode == "blocking" else None,
        "decision_ms": duration(job.created_at, job.decision_at),
        "review_remaining_ms": duration(job.review_ready_at, job.deadline),
    }


def percentiles(values):
    values = sorted(v for v in values if v is not None)
    return {"samples": len(values), **{f"p{n}_ms": values[max(0, math.ceil(len(values) * n / 100) - 1)] if values else None for n in (50, 95, 99)}}


def summary(db):
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    E = SafetyEvaluation
    # Never load action snapshots into a metrics query.
    fields = [E.created_at, E.returned_at, E.admitted_at, E.first_started_at, E.review_ready_at,
              E.human_decision, E.decision, E.deadline, E.attempts,
              E.result["source"].as_string().label("source"), E.result["recommendation"].as_string().label("recommendation")]
    jobs = [SimpleNamespace(**row) for row in db.execute(select(*fields).where(E.mode == "blocking", E.debug_result.is_(None), E.created_at >= since).order_by(E.created_at.desc()).limit(10001)).mappings()]
    truncated = len(jobs) > 10000
    jobs = jobs[:10000]
    automatic = [j for j in jobs if not j.review_ready_at and not j.human_decision and j.recommendation != "review"]
    return {
        "window_hours": 24, "requests": len(jobs), "truncated": truncated,
        "debug_requests": db.scalar(select(func.count()).select_from(E).where(E.mode == "blocking", E.debug_result.is_not(None), E.created_at >= since)),
        "automatic_pause": percentiles(duration(j.created_at, j.returned_at) for j in automatic),
        "automatic_paths": {path: percentiles(duration(j.created_at, j.returned_at) for j in automatic
            if ("rules" if j.source == "rules" else "judge" if j.attempts else "infrastructure") == path)
            for path in ("rules", "judge", "infrastructure")},
        "total_pause": percentiles(duration(j.created_at, j.returned_at) for j in jobs),
        "queue": percentiles(duration(j.admitted_at, j.first_started_at) for j in jobs),
        "blocked_agent_ms": sum(duration(j.created_at, j.returned_at) or 0 for j in jobs),
        "failed": sum(j.decision == "error" for j in jobs),
        "expired": sum(j.decision == "expired" for j in jobs),
        "missing_receipts": sum(j.decision is not None and j.returned_at is None for j in jobs),
        "reviews": sum(j.review_ready_at is not None for j in jobs),
        "short_review_window": sum(j.review_ready_at is not None and duration(j.review_ready_at, j.deadline) < 30000 for j in jobs),
    }
