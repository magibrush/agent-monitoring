"""One current safety state per action, independently of risk flags."""
from sqlalchemy import select, func, case, and_, or_
from backend.db import SafetyEvaluation, Event

STATES = ("pending", "awaiting_review", "released", "denied", "error", "shadow", "unassessed")


def latest():
    return select(SafetyEvaluation, func.row_number().over(partition_by=SafetyEvaluation.event_id,
        order_by=((SafetyEvaluation.mode == "blocking").desc(), SafetyEvaluation.created_at.desc(), SafetyEvaluation.id.desc())).label("rank")).subquery()


def state(columns):
    gate = columns.gate["decision"].as_string()
    return case(
        (and_(columns.returned_at.is_not(None), gate == "pass"), "released"),
        (or_(gate.in_(["error", "expired"]), columns.decision.in_(["error", "expired"]), columns.status.in_(["failed", "skipped"])), "error"),
        (or_(columns.decision == "deny", gate == "deny"), "denied"),
        (columns.status == "awaiting_review", "awaiting_review"),
        (columns.mode == "blocking", "pending"),
        (columns.status.in_(["queued", "running"]), "pending"),
        (columns.status == "completed", "shadow"), else_="unassessed")


def flagged(columns):
    return or_(columns.result["recommendation"].as_string().in_(["deny", "review"]), columns.result["risk"].as_string() == "high")


def aggregate(db, conditions, bucket, low, high):
    jobs = latest()
    relation = Event.__table__.outerjoin(jobs, and_(jobs.c.event_id == Event.id, jobs.c.rank == 1))
    fields = [func.sum(case((state(jobs.c) == s, 1), else_=0)).label(s) for s in STATES]
    fields += [func.sum(case((flagged(jobs.c), 1), else_=0)).label("flagged")]
    base = select(*fields).select_from(relation).where(*conditions, Event.kind == "tool_call")
    summary = {k: v or 0 for k, v in db.execute(base).mappings().one().items()}
    rows = db.execute(select(bucket.label("bucket"), *fields).select_from(relation).where(*conditions,
        Event.kind == "tool_call", Event.occurred_at >= low, Event.occurred_at < high).group_by(bucket)).mappings().all()
    return summary, {r["bucket"] * 1000: {k: r[k] or 0 for k in (*STATES, "flagged")} for r in rows}
