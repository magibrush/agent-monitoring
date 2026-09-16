"""Read-only Claude Code JSONL adapter; unrelated Claude Desktop data is excluded."""
import hashlib
import json

from sqlalchemy import select

from backend.connectors import (MAX_RECORD_BYTES, add_event, complete_records,
                                content_text, get_session, source_root, timestamp,
                                transcript_paths)
from backend.db import Checkpoint


def metadata(stream, path):
    stream.seek(0)
    first = stream.readline(MAX_RECORD_BYTES + 1)
    if len(first) > MAX_RECORD_BYTES:
        raise ValueError(f"Oversized transcript record in {path.name}")
    if not first.endswith(b"\n"):
        return None, None
    prefix = hashlib.sha256(first).hexdigest()
    # File history, queue operations and progress can precede the first message.
    for _, _, record in complete_records(stream, path, 0):
        if record.get("sessionId") and record.get("type") in {"user", "assistant", "system"}:
            return record, prefix
    return None, prefix


def identity(record, path):
    parent = str(record["sessionId"])
    nested = path.parent.name == "subagents"
    subagent = nested or bool(record.get("isSidechain")) or path.stem.startswith("agent-")
    if subagent:
        agent = str(record.get("agentId") or path.stem.removeprefix("agent-"))
        # Subagents commonly carry the parent's sessionId; never merge their
        # messages into the parent, or conflate two different agents.
        return f"{parent}:agent:{agent}", parent, "subagent"
    return parent, None, "conversation"


def inspect_claude(path):
    counts = {"claude_code": 0, "subagents": 0, "unknown": 0, "pending": 0}
    seen = set()
    for transcript in transcript_paths(source_root(path, "claude_code")):
        with transcript.open("rb") as stream:
            record, prefix = metadata(stream, transcript)
        if record is None:
            counts["pending" if prefix is None else "unknown"] += 1
            continue
        external, _, kind = identity(record, transcript)
        if external not in seen:
            counts["claude_code"] += 1
            counts["subagents"] += kind == "subagent"
            seen.add(external)
    return {"counts": counts, "matching_sessions": counts["claude_code"]}


def sync_claude(db, connection):
    count = 0
    for path in transcript_paths(source_root(connection.path, "claude_code")):
        checkpoint = db.scalar(select(Checkpoint).where(
            Checkpoint.connection_id == connection.id, Checkpoint.path == str(path)))
        with path.open("rb") as stream:
            head, prefix = metadata(stream, path)
            if checkpoint and (path.stat().st_size < checkpoint.offset or
                               (prefix and checkpoint.prefix_hash != prefix)):
                raise ValueError(f"Transcript was replaced or truncated: {path.name}. Create a new connection to re-import it.")
            if head is None:
                continue
            external, parent, kind = identity(head, path)
            session = get_session(db, connection, external, "Untitled session",
                                  timestamp(head.get("timestamp")), "claude_code")
            session.session_type = kind
            session.parent_thread_id = parent
            if checkpoint is None:
                checkpoint = Checkpoint(connection_id=connection.id, path=str(path), offset=0)
                db.add(checkpoint)
            checkpoint.session_id = session.id
            checkpoint.prefix_hash = prefix
            for offset, next_offset, record in complete_records(stream, path, checkpoint.offset):
                role = record.get("type")
                message = record.get("message")
                if role in {"user", "assistant"} and isinstance(message, dict):
                    if record.get("sessionId") != head["sessionId"]:
                        raise ValueError(f"Conflicting session identity in {path.name}")
                    content = message.get("content", [])
                    if isinstance(content, str):
                        content = [{"type": "text", "text": content}]
                    if not isinstance(content, list):
                        raise ValueError(f"Invalid message content in {path.name} at byte {offset}")
                    # UUID survives resume/copies. Hash fallback avoids duplicates
                    # when older transcripts omit UUIDs and are replayed.
                    record_id = str(record.get("uuid") or hashlib.sha256(
                        json.dumps(record, sort_keys=True).encode()).hexdigest())
                    time = timestamp(record.get("timestamp"), session.created_at)
                    for index, block in enumerate(content):
                        if not isinstance(block, dict):
                            continue
                        block_type = block.get("type")
                        event_id = f"{record_id}:block:{index}"
                        payload = {"record": record, "payload": block}
                        if block_type == "text" and block.get("text"):
                            count += add_event(db, session, event_id, "message", role,
                                               str(block["text"]), time, payload)
                        elif block_type == "tool_use" and role == "assistant":
                            count += add_event(db, session, event_id, "tool_call", "tool",
                                               json.dumps(block.get("input", {}), ensure_ascii=False),
                                               time, payload, block.get("name", "Unknown tool"))
                        elif block_type == "tool_result" and role == "user":
                            output = block.get("content", "")
                            text = content_text(output)
                            if not text and output:
                                text = json.dumps(output, ensure_ascii=False)
                            if block.get("is_error"):
                                text = "Error: " + text
                            count += add_event(db, session, event_id, "tool_result", "tool", text, time, payload)
                checkpoint.offset = next_offset
    return count
