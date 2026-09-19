"""Provider-reported usage, deduplicated independently of content blocks."""
import hashlib
import json
from sqlalchemy import select
from backend.db import TokenUsage


def number(value):
    return value if type(value) is int and value >= 0 else None


def save(db, session, identity, time, input_tokens, output_tokens):
    row = db.scalar(select(TokenUsage).where(TokenUsage.session_id == session.id, TokenUsage.external_id == identity))
    if row is None:
        db.add(TokenUsage(session_id=session.id, external_id=identity, occurred_at=time, input_tokens=input_tokens, output_tokens=output_tokens))
        db.flush()
    else:
        # Claude can repeat a message id across streamed content blocks.
        for name, value in (("input_tokens", input_tokens), ("output_tokens", output_tokens)):
            if value is not None:
                setattr(row, name, max(getattr(row, name) or 0, value))


def codex(db, session, record, time, state):
    info = record.get("payload", {}).get("info")
    if not isinstance(info, dict) or not isinstance(info.get("total_token_usage"), dict):
        return
    total = info["total_token_usage"]
    previous = state.get("_token_total")
    state["_token_total"] = total
    if previous == total:
        return
    counts = []
    for key in ("input_tokens", "output_tokens"):
        current = number(total.get(key))
        before = number(previous.get(key)) if isinstance(previous, dict) else None
        counts.append(None if current is None else current - before if before is not None and current >= before else current)
    # Some Desktop logs fill the split with zeros despite nonzero total usage.
    if total.get("total_tokens", 0) > 0 and total.get("input_tokens") == total.get("output_tokens") == 0:
        counts = [None, None]
    identity = "codex:" + hashlib.sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()
    save(db, session, identity, time, *counts)


def claude(db, session, message, record_id, time):
    usage = message.get("usage")
    if not isinstance(usage, dict):
        return
    raw = number(usage.get("input_tokens"))
    input_tokens = None if raw is None else raw + sum(number(usage.get(k)) or 0 for k in ("cache_creation_input_tokens", "cache_read_input_tokens"))
    save(db, session, "claude:" + str(message.get("id") or record_id), time, input_tokens, number(usage.get("output_tokens")))
