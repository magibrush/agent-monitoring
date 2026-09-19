"""Read-only adapters. Source apps are never resumed, modified, or controlled."""
import hashlib
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select

from backend.db import ChatSession, Checkpoint, Connection, Event, now
from backend.normalization import message_content, action_category, session_type
from backend.providers import PROVIDERS, codex_source

MAX_RECORD_BYTES = 50 * 1024 * 1024
logger = logging.getLogger(__name__)


def source_root(path, provider="codex"):
    root = Path(path).expanduser().resolve()
    # Accept a Codex home folder as well as the sessions directory.
    child = "projects" if provider == "claude_code" else "sessions"
    if (root / child).is_dir():
        root = root / child
    if not root.is_dir():
        raise ValueError("Session directory is unavailable. Check the path and permissions.")
    return root


def transcript_paths(root):
    for path in sorted(root.rglob("*.jsonl")):
        if path.resolve().is_relative_to(root):
            yield path


def read_metadata(stream, path):
    first = stream.readline(MAX_RECORD_BYTES + 1)
    if len(first) > MAX_RECORD_BYTES:
        raise ValueError(f"Oversized transcript record in {path.name}")
    if not first.endswith(b"\n"):
        return None, None
    try:
        record = json.loads(first)
        metadata = record.get("payload")
        if record.get("type") != "session_meta" or not isinstance(metadata, dict):
            raise ValueError("Invalid metadata")
    except (ValueError, AttributeError):
        raise ValueError(f"Unrecognized Codex metadata in {path.name}")
    return metadata, hashlib.sha256(first).hexdigest()


def complete_records(stream, path, offset, limit=5000):
    """Shared bounded JSONL reader; incomplete final writes are retried."""
    stream.seek(offset)
    for _ in range(limit):
        start = stream.tell()
        line = stream.readline(MAX_RECORD_BYTES + 1)
        if len(line) > MAX_RECORD_BYTES:
            raise ValueError(f"Oversized transcript record in {path.name}")
        if not line or not line.endswith(b"\n"):
            break
        try:
            record = json.loads(line)
            if not isinstance(record, dict):
                raise ValueError("Invalid record")
        except ValueError:
            raise ValueError(f"Invalid JSON record in {path.name} at byte {start}")
        yield start, stream.tell(), record


def inspect_source(path, provider):
    if provider == "claude_code":
        from backend.claude_code import inspect_claude
        return inspect_claude(path)
    counts = {"desktop": 0, "cli": 0, "unknown": 0, "pending": 0}
    for transcript in transcript_paths(source_root(path)):
        with transcript.open("rb") as stream:
            metadata, _ = read_metadata(stream, transcript)
        counts["pending" if metadata is None else codex_source(metadata) or "unknown"] += 1
    return {"counts": counts, "matching_sessions": counts[PROVIDERS[provider].source]}


def sync_connection(db, connection):
    from backend.claude_code import sync_claude
    if PROVIDERS[connection.provider].adapter == "codex":
        return sync_codex(db, connection)
    return sync_claude(db, connection)


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
    call_id = details.get("call_id") or details.get("tool_use_id") or (details.get("id") if details.get("type") == "tool_use" else None)
    if kind == "tool_call" and call_id:
        observed = db.scalar(select(Event).where(Event.session_id == session.id, Event.kind == "tool_call", Event.tool_call_id == call_id, Event.transcript_seen.is_(False)))
        if observed is not None:
            observed.external_id, observed.text, observed.payload = external_id, text, payload
            observed.tool_name, observed.occurred_at = tool_name, time
            observed.action_category = action_category(tool_name, text)
            observed.transcript_seen = True
            session.updated_at = max(session.updated_at, time)
            return 0
    if kind == "message":
        kind, text = message_content(text, role)
    if kind == "tool_result" and call_id:
        observed = db.scalar(select(Event).where(Event.session_id == session.id, Event.kind == "tool_call", Event.tool_call_id == call_id))
        if observed is not None and observed.hook_state == "requested":
            observed.hook_state = "failed" if details.get("is_error") is True else "unknown"
    db.add(Event(session_id=session.id, external_id=external_id, kind=kind, role=role, text=text, tool_name=tool_name, action_category=action_category(tool_name, text) if kind == "tool_call" else "other", occurred_at=time, payload=payload, tool_call_id=details.get("call_id") or details.get("tool_use_id") or (details.get("id") if details.get("type") == "tool_use" else None), turn_id=details.get("turn_id")))
    session.updated_at = max(session.updated_at, time)
    if session.title == "Untitled session" and kind == "message" and role == "user" and text:
        session.title = text.strip().splitlines()[0][:120]
    return 1


def record_identity(record):
    # Ordinals and envelope metadata can be added when Codex rewrites a rollout.
    # Require identical event contents and timestamps, not identical byte layout.
    return json.dumps([record.get("type"), record.get("timestamp"), record.get("payload")],
                      sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def replay_id(record, counts):
    digest = hashlib.sha256(record_identity(record).encode()).hexdigest()
    counts[digest] = counts.get(digest, 0) + 1
    return f"record:{digest}:{counts[digest]}"


def migrate_byte_ids(db, session):
    """Lazy migration retains primary keys and all attached audit evidence."""
    legacy = list(db.scalars(select(Event).where(Event.session_id == session.id,
        Event.external_id.like("byte:%"))))
    legacy.sort(key=lambda event: int(event.external_id[5:]))
    counts = {}
    occupied = set(db.scalars(select(Event.external_id).where(Event.session_id == session.id)))
    for event in legacy:
        identity = replay_id(event.payload, counts)
        while identity in occupied:
            identity = replay_id(event.payload, counts)
        occupied.add(identity)
        event.external_id = identity
    db.flush()


def checkpoint_tail(stream, offset):
    stream.seek(max(0, offset - 4096))
    return hashlib.sha256(stream.read(min(offset, 4096))).hexdigest()


def sync_codex(db, connection):
    root = source_root(connection.path)
    expected_source = PROVIDERS[connection.provider].source
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
    unknown = 0
    for path in transcript_paths(root):
        checkpoint = db.scalar(select(Checkpoint).where(Checkpoint.connection_id == connection.id, Checkpoint.path == str(path)))
        with path.open("rb") as stream:
            metadata, prefix = read_metadata(stream, path)
            if metadata is None:
                continue
            source = codex_source(metadata)
            if source is None:
                unknown += 1
            if source != expected_source:
                continue
            moved = False
            if checkpoint and checkpoint.offset:
                stream.seek(checkpoint.offset - 1)
                moved = stream.read(1) != b"\n"
            replay = checkpoint and (checkpoint.record_counts is None or moved or
                path.stat().st_size < checkpoint.offset or checkpoint.prefix_hash != prefix or
                (checkpoint.tail_hash and checkpoint_tail(stream, checkpoint.offset) != checkpoint.tail_hash))
            if checkpoint is None:
                checkpoint = Checkpoint(connection_id=connection.id, path=str(path), offset=0)
                db.add(checkpoint)
            external = metadata.get("id") or metadata.get("session_id")
            if not external:
                raise ValueError(f"Missing session identity in {path.name}")
            session = get_session(db, connection, external, "Untitled session", timestamp(metadata.get("timestamp")), source)
            if replay or checkpoint.session_id != session.id:
                migrate_byte_ids(db, session)
                checkpoint.offset = 0
                checkpoint.record_counts = {}
                logger.debug("Replaying rewritten Codex transcript %s; imported history is retained", path.name)
            checkpoint.prefix_hash = prefix
            counts = dict(checkpoint.record_counts or {})
            session.session_type = session_type(metadata)
            session.parent_thread_id = metadata.get("parent_thread_id")
            if titles.get(external):
                session.title = titles[external][:500]
            elif session.title.startswith(("<", "# AGENTS.md")):
                first_message = db.scalar(select(Event.text).where(Event.session_id == session.id, Event.kind == "message", Event.role == "user").order_by(Event.id).limit(1))
                session.title = first_message.strip().splitlines()[0][:120] if first_message else "Untitled session"
            checkpoint.session_id = session.id
            for offset, next_offset, record in complete_records(stream, path, checkpoint.offset):
                payload = record.get("payload", {})
                if not isinstance(payload, dict):
                    raise ValueError(f"Invalid JSON record in {path.name} at byte {offset}")
                time = timestamp(record.get("timestamp"), session.created_at)
                type_ = payload.get("type")
                # response_item is canonical. event_msg message mirrors would double-count.
                if record.get("type") == "response_item":
                    if type_ == "message" and payload.get("role") in ("user", "assistant"):
                        text = content_text(payload.get("content"))
                        if text:
                            count += add_event(db, session, replay_id(record, counts), "message", payload["role"], text, time, record)
                    elif type_ in ("function_call", "custom_tool_call"):
                        count += add_event(db, session, replay_id(record, counts), "tool_call", "tool", str(payload.get("arguments", payload.get("input", ""))), time, record, payload.get("name", "Unknown tool"))
                    elif type_ in ("function_call_output", "custom_tool_call_output"):
                        output = payload.get("output", "")
                        count += add_event(db, session, replay_id(record, counts), "tool_result", "tool", output if isinstance(output, str) else json.dumps(output), time, record)
                checkpoint.offset = next_offset
            checkpoint.record_counts = counts
            checkpoint.tail_hash = checkpoint_tail(stream, checkpoint.offset)
    if unknown:
        logger.info("Connection %s skipped %s transcripts with unsupported provenance", connection.id, unknown)
    return count
