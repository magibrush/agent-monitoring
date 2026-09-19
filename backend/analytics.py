"""Shared search, session selection and bounded time-series aggregation."""
import math
import re
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import and_, case, func, or_, select

from backend.db import ChatSession, Connection, Event
from backend.providers import PROVIDERS

router = APIRouter(prefix="/api")
# Keep the factory replaceable by the application's tests.
def store():
    from backend.main import SessionLocal
    return SessionLocal()


def dump(model):
    return {c.name: getattr(model, c.name) for c in model.__table__.columns}


class Filters(BaseModel):
    provider: str = ""
    connection: str = ""
    q: str = Field("", max_length=200)
    search_mode: Literal["words", "contains"] = "words"
    search_scope: Literal["messages", "actions", "all", "titles"] = "messages"
    session_ids: str = ""
    start: str = ""
    end: str = ""
    days: int = Field(0, ge=0, le=3650)
    action: Literal["", "any", "deletion", "file_write", "read", "shell", "network", "other"] = ""
    tool: str = Field("", max_length=200)
    include_internal: bool = False
    session_type: Literal["", "conversation", "subagent"] = ""


def instant(value):
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return dt.replace(tzinfo=dt.tzinfo or timezone.utc).astimezone(timezone.utc)
    except (ValueError, OverflowError):
        raise HTTPException(422, "Invalid date/time. Use an ISO date with timezone.")


def bounds(f):
    start = instant(f.start) if f.start else (datetime.now(timezone.utc) - timedelta(days=f.days) if f.days else None)
    end = instant(f.end) if f.end else None
    if start and end and start >= end:
        raise HTTPException(422, "The end must be after the start.")
    if start and end and (end-start).days > 36525:
        raise HTTPException(422, "Choose a range of at most 100 years.")
    return start, end


def time_filters(f):
    start, end = bounds(f)
    return ([Event.occurred_at >= start.isoformat()] if start else []) + ([Event.occurred_at < end.isoformat()] if end else [])


def text_match(column, f):
    if f.search_mode == "contains":
        return column.icontains(f.q, autoescape=True)
    return column.regexp_match(r"(?i)(?<!\w)" + re.escape(f.q) + r"(?!\w)")


def search_events(f):
    kinds = {"messages": ["message"], "actions": ["tool_call", "tool_result"], "all": ["message", "tool_call", "tool_result"], "titles": []}[f.search_scope]
    return and_(Event.kind.in_(kinds), text_match(Event.text, f))


def action_filters(f):
    conditions = [Event.kind == "tool_call"]
    if f.action and f.action != "any":
        conditions.append(Event.action_category == f.action)
    if f.tool:
        conditions.append(Event.tool_name.icontains(f.tool, autoescape=True))
    return conditions


def selected_sessions(f):
    conditions = [Connection.provider.in_(PROVIDERS)]
    if not f.include_internal:
        conditions.append(ChatSession.session_type != "internal_review")
    if f.session_type:
        conditions.append(ChatSession.session_type == f.session_type)
    if f.provider:
        conditions.append(Connection.provider == f.provider)
    if f.connection:
        conditions.append(Connection.id == f.connection)
    if f.session_ids:
        conditions.append(ChatSession.id.in_(f.session_ids.split(",")))
    timed = time_filters(f)
    if timed:
        conditions.append(ChatSession.id.in_(select(Event.session_id).where(Event.kind != "context", *timed)))
    if f.action or f.tool:
        conditions.append(ChatSession.id.in_(select(Event.session_id).where(*action_filters(f), *timed)))
    if f.q:
        match = ChatSession.id.in_(select(Event.session_id).where(search_events(f), *timed))
        if f.search_scope in ("messages", "all", "titles"):
            match = or_(text_match(ChatSession.title, f), match)
        conditions.append(match)
    return select(ChatSession.id).join(Connection).where(*conditions)


def excerpt(text, f):
    pattern = re.escape(f.q) if f.search_mode == "contains" else r"(?<!\w)" + re.escape(f.q) + r"(?!\w)"
    match = re.search(pattern, text, re.I)
    if not match:
        return text[:180]
    a, b = max(0, match.start() - 70), min(len(text), match.end() + 120)
    return ("…" if a else "") + text[a:b] + ("…" if b < len(text) else "")


@router.get("/sessions")
def sessions(f: Filters = Depends(), sort: Literal["recent", "messages", "actions", "title"] = "recent", offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200)):
    action_count = and_(*action_filters(f))
    counts = select(Event.session_id, func.sum(case((Event.kind == "message", 1), else_=0)).label("messages"), func.sum(case((action_count, 1), else_=0)).label("actions")).where(*time_filters(f)).group_by(Event.session_id).subquery()
    query = select(ChatSession, Connection.name, Connection.provider, func.coalesce(counts.c.messages, 0), func.coalesce(counts.c.actions, 0)).join(Connection).outerjoin(counts, counts.c.session_id == ChatSession.id).where(ChatSession.id.in_(selected_sessions(f)))
    ordering = {"recent": ChatSession.updated_at.desc(), "messages": func.coalesce(counts.c.messages, 0).desc(), "actions": func.coalesce(counts.c.actions, 0).desc(), "title": ChatSession.title.asc()}[sort]
    with store() as db:
        total = db.scalar(select(func.count()).select_from(query.subquery()))
        rows = db.execute(query.order_by(ordering, ChatSession.id).offset(offset).limit(limit)).all()
        items = []
        for session, name, provider, messages, actions in rows:
            match = None
            if f.q:
                event = db.scalar(select(Event).where(Event.session_id == session.id, search_events(f), *time_filters(f)).order_by(Event.occurred_at).limit(1))
                match = {"kind": event.kind if event else "title", "text": excerpt(event.text if event else session.title, f), "event_id": event.id if event else None}
            items.append({**dump(session), "connection_name": name, "provider": provider, "messages": messages, "actions": actions, "match": match})
        return {"total": total, "items": items}


INTERVALS = [(60, "1 minute"), (300, "5 minutes"), (900, "15 minutes"), (3600, "1 hour"), (21600, "6 hours"), (86400, "1 day"), (604800, "1 week"), (2592000, "30 days"), (31536000, "1 year")]


@router.get("/metrics")
def metrics(f: Filters = Depends(), interval: int = Query(0, ge=0), view_start: str = "", view_end: str = "", conversations: bool = False):
    if interval and interval not in dict(INTERVALS):
        raise HTTPException(422, "Unsupported bucket interval.")
    selected = selected_sessions(f)
    conditions = [Event.session_id.in_(selected), Event.kind != "context", *time_filters(f)]
    # Keep conversation counts alongside only the action calls matching the filter.
    if f.action or f.tool:
        conditions.append(or_(Event.kind == "message", and_(*action_filters(f))))
    with store() as db:
        base = select(Event).where(*conditions).subquery()
        counts = dict(db.execute(select(base.c.kind, func.count()).group_by(base.c.kind)).all())
        roles = dict(db.execute(select(base.c.role, func.count()).where(base.c.kind == "message").group_by(base.c.role)).all())
        active = db.scalar(select(func.count(func.distinct(base.c.session_id))))
        first, last = db.execute(select(func.min(base.c.occurred_at), func.max(base.c.occurred_at))).one()
        start, end = bounds(f)
        low = (start or (instant(first) if first else datetime.now(timezone.utc))).timestamp()
        high = (end or (instant(last) if last else datetime.now(timezone.utc))).timestamp()
        if not start and not end:
            # Padding makes one-event/single-minute histories legible.
            padding = max(60, min((high - low) * .03, 86400))
            low -= padding
            high += padding
        domain = {"start": datetime.fromtimestamp(low, timezone.utc).isoformat(), "end": datetime.fromtimestamp(high, timezone.utc).isoformat()}
        if bool(view_start) != bool(view_end):
            raise HTTPException(422, "Provide both viewport endpoints.")
        if view_start:
            low, high = instant(view_start).timestamp(), instant(view_end).timestamp()
            if high <= low:
                raise HTTPException(422, "Invalid viewport range.")
        span = max(60, high - low)
        automatic = next((seconds for seconds, _ in INTERVALS if span / seconds <= 100), INTERVALS[-1][0])
        seconds = interval or automatic
        window_limited = bool(interval and span / seconds > 600)
        if window_limited:
            # Honor explicit resolution. Page through time instead of silently
            # returning coarser buckets under a finer-resolution control.
            low = max(low, high - seconds * 600)
        if high <= low:
            high = low + seconds
        left = math.floor(low / seconds) * seconds
        right = math.floor(high / seconds) * seconds
        rows = [{"time": int(t * 1000), "user": 0, "assistant": 0, "actions": 0} for t in range(int(left), int(right) + 1, seconds)]
        slots = {row["time"]: row for row in rows}
        # Aggregate in SQL; at most 3 * number-of-buckets rows cross into Python.
        epoch = func.unixepoch(Event.occurred_at)
        bucket = epoch - ((epoch % seconds + seconds) % seconds)
        grouped = db.execute(select(bucket, Event.role, Event.kind, func.count()).where(*conditions, Event.kind.in_(["message", "tool_call"]), Event.occurred_at >= datetime.fromtimestamp(low, timezone.utc).isoformat(), Event.occurred_at < datetime.fromtimestamp(high, timezone.utc).isoformat()).group_by(bucket, Event.role, Event.kind)).all()
        for stamp, role, kind, count in grouped:
            row = slots.get(stamp * 1000)
            if row is not None:
                row["actions" if kind == "tool_call" else "user" if role == "user" else "assistant"] += count
        tool_rows = db.execute(select(bucket, Event.tool_name, func.count()).where(*conditions, Event.kind == "tool_call", Event.occurred_at >= datetime.fromtimestamp(low, timezone.utc).isoformat(), Event.occurred_at < datetime.fromtimestamp(high, timezone.utc).isoformat()).group_by(bucket, Event.tool_name)).all()
        for row in rows:
            row["tools"] = []
        for stamp, name, amount in tool_rows:
            if stamp * 1000 in slots:
                slots[stamp * 1000]["tools"].append({"name": name or "Unknown tool", "count": amount})
        for row in rows:
            row["tools"].sort(key=lambda item: (-item["count"], item["name"]))
        from backend.safety_analytics import aggregate
        safety_summary, safety_slots = aggregate(db, conditions, bucket,
            datetime.fromtimestamp(low, timezone.utc).isoformat(), datetime.fromtimestamp(high, timezone.utc).isoformat())
        for row in rows:
            row["safety"] = safety_slots.get(row["time"], {})
        tools = db.execute(select(base.c.tool_name, func.count()).where(base.c.kind == "tool_call").group_by(base.c.tool_name).order_by(func.count().desc()).limit(8)).all()
        conversation_info = []
        if conversations:
            # Fixed across the full selected scope, not re-ranked on zoom.
            top = list(db.scalars(select(base.c.session_id).where(base.c.kind.in_(["message", "tool_call"])).group_by(base.c.session_id).order_by(func.count().desc(), base.c.session_id).limit(8)))
            if top:
                for session, connection in db.execute(select(ChatSession, Connection).join(Connection).where(ChatSession.id.in_(top)).order_by(ChatSession.id)):
                    conversation_info.append({"id": session.id, "title": session.title, "provider": connection.provider, "connection_name": connection.name})
            conversation_info.append({"id": "other", "title": "Other conversations", "provider": "", "connection_name": ""})
            identity = case((Event.session_id.in_(top), Event.session_id), else_="other")
            composition = db.execute(select(bucket, identity, Event.kind, func.count()).where(*conditions, Event.kind.in_(["message", "tool_call"]), Event.occurred_at >= datetime.fromtimestamp(low, timezone.utc).isoformat(), Event.occurred_at < datetime.fromtimestamp(high, timezone.utc).isoformat()).group_by(bucket, identity, Event.kind)).all()
            by_slot = {}
            for stamp, identity_, kind, amount in composition:
                key = (stamp * 1000, identity_)
                item = by_slot.setdefault(key, {"id": identity_, "actions": 0, "messages": 0})
                item["actions" if kind == "tool_call" else "messages"] += amount
            for row in rows:
                row["conversations"] = [by_slot[(row["time"], item["id"])] for item in conversation_info if (row["time"], item["id"]) in by_slot]
        return {"safety": safety_summary, "conversation_series": conversation_info, "sessions": active, "messages": counts.get("message", 0), "questions": roles.get("user", 0), "answers": roles.get("assistant", 0), "actions": counts.get("tool_call", 0), "series": rows, "interval_seconds": seconds, "interval_label": dict(INTERVALS)[seconds], "interval_adjusted": False, "window_limited": window_limited, "domain": domain, "viewport": {"start": datetime.fromtimestamp(low, timezone.utc).isoformat(), "end": datetime.fromtimestamp(high, timezone.utc).isoformat()}, "tools": [{"name": t or "Unknown tool", "count": n} for t, n in tools]}


@router.get("/sessions/{id_}/events")
def events(id_: str, f: Filters = Depends(), offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=200), kind: str = "", include_context: bool = False, anchor: int | None = None):
    with store() as db:
        session = db.get(ChatSession, id_)
        if not session or db.get(Connection, session.connection_id).provider not in PROVIDERS:
            raise HTTPException(404, "Session not found.")
        query = select(Event).where(Event.session_id == id_, *time_filters(f))
        if not include_context:
            query = query.where(Event.kind != "context")
        if kind:
            query = query.where(Event.kind == kind)
        if f.action or f.tool:
            query = query.where(*action_filters(f))
        if f.q:
            query = query.where(search_events(f))
        if anchor:
            item = db.get(Event, anchor)
            if item and item.session_id == id_:
                before = db.scalar(select(func.count()).select_from(query.where(or_(Event.occurred_at < item.occurred_at, and_(Event.occurred_at == item.occurred_at, Event.id < item.id))).subquery()))
                offset = (before // limit) * limit
        total = db.scalar(select(func.count()).select_from(query.subquery()))
        items = list(db.scalars(query.order_by(Event.occurred_at, Event.id).offset(offset).limit(limit)))
        from backend.db import SafetyEvaluation
        from backend.safety import public
        evaluations = {}
        for job in db.scalars(select(SafetyEvaluation).where(SafetyEvaluation.event_id.in_([e.id for e in items])).order_by(SafetyEvaluation.created_at)):
            evaluations.setdefault(job.event_id, []).append(public(job))
        return {"session": dump(session), "total": total, "offset": offset, "items": [{**{k: v for k, v in dump(e).items() if k != "payload"}, "evaluations": evaluations.get(e.id, [])} for e in items]}


@router.get("/safety/actions")
def safety_actions(f: Filters = Depends(), safety_state: Literal["", "pending", "awaiting_review", "released", "denied", "error", "shadow", "unassessed"] = "",
                   flagged_only: bool = False, offset: int = Query(0, ge=0), limit: int = Query(20, ge=1, le=100)):
    from backend.db import SafetyEvaluation
    from backend.safety_analytics import latest, state, flagged
    from backend.safety import public
    jobs = latest()
    query = select(Event, SafetyEvaluation, ChatSession.title, state(jobs.c).label("safety_state"), flagged(jobs.c).label("flagged")).select_from(Event)
    query = query.outerjoin(jobs, and_(jobs.c.event_id == Event.id, jobs.c.rank == 1)).outerjoin(SafetyEvaluation, SafetyEvaluation.id == jobs.c.id).join(ChatSession, ChatSession.id == Event.session_id)
    query = query.where(Event.session_id.in_(selected_sessions(f)), *time_filters(f), *action_filters(f))
    if safety_state:
        query = query.where(state(jobs.c) == safety_state)
    if flagged_only:
        query = query.where(flagged(jobs.c))
    with store() as db:
        total = db.scalar(select(func.count()).select_from(query.subquery()))
        rows = db.execute(query.order_by(Event.occurred_at.desc(), Event.id.desc()).offset(offset).limit(limit)).all()
        return {"total": total, "items": [{"event_id": e.id, "session_id": e.session_id, "title": title,
            "tool_name": e.tool_name, "occurred_at": e.occurred_at, "execution_outcome": e.hook_state,
            "safety_state": outcome, "flagged": bool(flag), "evaluation": public(job) if job else None}
            for e, job, title, outcome, flag in rows]}
