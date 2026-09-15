"""Read-only adapters. Source apps are never resumed, modified, or controlled."""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select

from backend.db import ChatSession, Checkpoint, Connection, Event, now

MAX_RECORD_BYTES = 50 * 1024 * 1024


def timestamp(value, fallback=None):
    try:
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value, timezone.utc).isoformat()
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=parsed.tzinfo or timezone.utc).astimezone(timezone.utc).isoformat()
    except (ValueError, TypeError, AttributeError, OverflowError, OSError):
        return fallback or now()


def content_text(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(str(block.get("text", "")) for block in content if isinstance(block, dict) and block.get("type") in ("text", "input_text", "output_text"))


def get_session(db, connection, external_id, title, time, source):
    session = db.scalar(select(ChatSession).where(ChatSession.connection_id == connection.id, ChatSession.external_id == external_id))
    if session is None:
        session = ChatSession(connection_id=connection.id, external_id=external_id, title=title, created_at=time, updated_at=time, source=source)
        db.add(session)
        db.flush()
    return session


def add_event(db, session, external_id, kind, role, text, time, payload, tool_name=None):
    existing = db.scalar(select(Event.id).where(Event.session_id == session.id, Event.external_id == external_id))
    if existing is not None:
        return 0
    details = payload.get("payload", payload)
    db.add(Event(session_id=session.id, external_id=external_id, kind=kind, role=role, text=text, tool_name=tool_name, occurred_at=time, payload=payload, tool_call_id=details.get("call_id") or details.get("tool_use_id") or (details.get("id") if details.get("type") == "tool_use" else None), turn_id=details.get("turn_id")))
    session.updated_at = max(session.updated_at, time)
    if session.title == "Untitled session" and role == "user" and text:
        session.title = text.strip().splitlines()[0][:120]
    return 1


def sync_codex(db, connection):
    root = Path(connection.path).expanduser().resolve()
    if not root.is_dir():
        raise ValueError("Session directory is unavailable. Check the path and permissions.")
    count = 0
    titles = {}
    # Optional Desktop index: names are better than injected setup messages.
    index = root.parent / "session_index.jsonl"
    if index.is_file():
        with index.open(encoding="utf-8") as entries:
            for line in entries:
                try:
                    entry = json.loads(line)
                    if isinstance(entry, dict) and isinstance(entry.get("thread_name"), str):
                        titles[entry.get("id")] = entry["thread_name"]
                except ValueError:
                    continue
    for path in sorted(root.rglob("*.jsonl")):
        if not path.resolve().is_relative_to(root):
            continue
        checkpoint = db.scalar(select(Checkpoint).where(Checkpoint.connection_id == connection.id, Checkpoint.path == str(path)))
        if checkpoint is None:
            checkpoint = Checkpoint(connection_id=connection.id, path=str(path), offset=0)
            db.add(checkpoint)
        with path.open("rb") as stream:
            first = stream.readline(MAX_RECORD_BYTES + 1)
            if not first.endswith(b"\n"):
                continue
            prefix = hashlib.sha256(first).hexdigest()
            if checkpoint.prefix_hash and (checkpoint.prefix_hash != prefix or path.stat().st_size < checkpoint.offset):
                raise ValueError(f"Transcript was replaced or truncated: {path.name}. Create a new connection to re-import it.")
            try:
                metadata = json.loads(first).get("payload", {})
            except (ValueError, AttributeError):
                raise ValueError(f"Unrecognized Codex metadata in {path.name}")
            # 'vscode' alone also covers the extension; require Desktop provenance.
            if "desktop" not in str(metadata.get("originator", "")).lower():
                continue
            external = metadata.get("id") or metadata.get("session_id")
            if not external:
                raise ValueError(f"Missing session identity in {path.name}")
            checkpoint.prefix_hash = prefix
            session = get_session(db, connection, external, "Untitled session", timestamp(metadata.get("timestamp")), "desktop")
            if titles.get(external):
                session.title = titles[external][:500]
            checkpoint.session_id = session.id
            stream.seek(checkpoint.offset)
            for _ in range(5000):
                offset = stream.tell()
                line = stream.readline(MAX_RECORD_BYTES + 1)
                if not line or not line.endswith(b"\n"):
                    if len(line) > MAX_RECORD_BYTES:
                        raise ValueError(f"Oversized transcript record in {path.name}")
                    break  # An in-flight write is retried next poll.
                try:
                    record = json.loads(line)
                    payload = record.get("payload", {})
                    if not isinstance(payload, dict):
                        raise ValueError("Invalid payload")
                except (ValueError, AttributeError):
                    raise ValueError(f"Invalid JSON record in {path.name} at byte {offset}")
                time = timestamp(record.get("timestamp"), session.created_at)
                type_ = payload.get("type")
                # response_item is canonical. event_msg message mirrors would double-count.
                if record.get("type") == "response_item":
                    if type_ == "message" and payload.get("role") in ("user", "assistant"):
                        text = content_text(payload.get("content"))
                        if text:
                            count += add_event(db, session, f"byte:{offset}", "message", payload["role"], text, time, record)
                    elif type_ in ("function_call", "custom_tool_call"):
                        count += add_event(db, session, f"byte:{offset}", "tool_call", "tool", str(payload.get("arguments", payload.get("input", ""))), time, record, payload.get("name", "Unknown tool"))
                    elif type_ in ("function_call_output", "custom_tool_call_output"):
                        output = payload.get("output", "")
                        count += add_event(db, session, f"byte:{offset}", "tool_result", "tool", output if isinstance(output, str) else json.dumps(output), time, record)
                checkpoint.offset = stream.tell()
    return count
