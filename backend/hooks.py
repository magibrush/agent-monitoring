"""Observation only: provider commands enqueue; Relay reconciles by exact call ID."""
import hashlib
import itertools
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
from uuid import uuid4

from sqlalchemy import select

from backend.connectors import get_session, read_metadata, source_root, timestamp
from backend.db import Event, HookObservation, ROOT
from backend.normalization import action_category, session_type
from backend.providers import PROVIDERS, codex_source

PHASES = ("PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionDenied")


def queue_path(connection):
    return Path(os.getenv("RELAY_HOOK_QUEUE", str(ROOT / "data/hook-queue"))) / connection.id


def setup(connection):
    root = source_root(connection.path, connection.provider)
    expected = "projects" if connection.provider == "claude_code" else "sessions"
    if root.name != expected:
        raise ValueError(f"Hook setup requires a profile's {expected} directory; archives and individual project folders use transcript monitoring.")
    target = root.parent / ("settings.json" if connection.provider == "claude_code" else "hooks.json")
    args = [sys.executable, str(ROOT / "scripts/observe_hook.py"), str(queue_path(connection))]
    command = subprocess.list2cmdline(args) if os.name == "nt" else shlex.join(args)
    phases = PHASES if connection.provider == "claude_code" else PHASES[:2]
    handler = {"type": "command", "command": command, "timeout": 3}
    # Claude's exec form avoids shell-dependent path quoting altogether.
    if connection.provider == "claude_code":
        handler["command"], handler["args"] = args[0], args[1:]
    if os.name == "nt" and connection.provider != "claude_code":
        handler["commandWindows"] = command
    return target, {"hooks": {phase: [{"hooks": [dict(handler)]}] for phase in phases}}


def configure(connection, enabled):
    """Merge only our exact queue's handlers. Preserve all other provider settings."""
    target, addition = setup(connection)
    original = target.read_bytes() if target.exists() else None
    document = json.loads(original.decode("utf-8-sig")) if original else {}
    if not isinstance(document, dict) or not isinstance(document.get("hooks", {}), dict):
        raise ValueError("Invalid provider hook configuration; no settings were changed.")
    hooks = document.setdefault("hooks", {})
    marker = str(queue_path(connection)).replace("\\", "/")
    for phase, groups in hooks.items():
        if not isinstance(groups, list):
            raise ValueError("Unsupported hook configuration; no settings were changed.")
        for group in groups:
            if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
                raise ValueError("Unsupported hook configuration; no settings were changed.")
            def owned(handler):
                if not isinstance(handler, dict):
                    return False
                invocation = str(handler.get("command", "")) + " " + " ".join(map(str, handler.get("args", [])))
                return "observe_hook.py" in invocation and marker in invocation.replace("\\", "/")
            group["hooks"] = [h for h in group["hooks"] if not owned(h)]
        hooks[phase] = [g for g in groups if g["hooks"]]
    if enabled:
        for phase, groups in addition["hooks"].items():
            hooks.setdefault(phase, []).extend(groups)
    queue = queue_path(connection)
    queue.mkdir(parents=True, exist_ok=True)
    # Refuse a concurrent edit detected since the initial read.
    if (target.read_bytes() if target.exists() else None) != original:
        raise ValueError("Provider settings changed during setup. Try again.")
    if original is not None:
        target.with_name(target.name + ".relay-backup-" + uuid4().hex).write_bytes(original)
    temporary = target.with_name(target.name + ".relay-" + uuid4().hex + ".tmp")
    try:
        temporary.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    if enabled:
        (queue / "enabled").touch()
    else:
        (queue / "enabled").unlink(missing_ok=True)
    connection.hooks_enabled = enabled


def resolve_session(db, connection, payload, received):
    path_value = payload.get("transcript_path")
    if not isinstance(path_value, str) or not path_value:
        raise ValueError("Hook has no transcript path; cannot safely associate its session")
    path = Path(path_value).expanduser().resolve()
    root = source_root(connection.path, connection.provider)
    if not path.is_relative_to(root) or path.suffix != ".jsonl":
        return None  # Another profile/project: never follow an arbitrary path.
    with path.open("rb") as stream:
        if connection.provider == "claude_code":
            from backend.claude_code import metadata, identity
            head, _ = metadata(stream, path)
            if head is None:
                raise OSError("Waiting for transcript identity")
            if payload.get("session_id") != head.get("sessionId"):
                raise ValueError("Hook session identity does not match its transcript")
            external, parent, kind = identity(head, path)
            # Some Claude versions identify the active subagent only in the hook.
            agent = payload.get("agent_id")
            if agent and kind == "conversation":
                external, parent, kind = f"{external}:agent:{agent}", external, "subagent"
            source = "claude_code"
        else:
            head, _ = read_metadata(stream, path)
            if head is None:
                raise OSError("Waiting for transcript identity")
            source = codex_source(head)
            if source != PROVIDERS[connection.provider].source:
                return None
            external = head.get("id") or head.get("session_id")
            parent, kind = head.get("parent_thread_id"), session_type(head)
            if not external or payload.get("session_id") not in {external, parent}:
                raise ValueError("Hook session identity does not match its transcript")
    session = get_session(db, connection, external, "Untitled session", received, source)
    session.session_type, session.parent_thread_id = kind, parent
    return session


def outcome(payload):
    phase = payload["hook_event_name"]
    if phase == "PreToolUse":
        return "requested"
    if phase == "PostToolUseFailure":
        return "failed"
    if phase == "PermissionDenied":
        return "denied"
    response = payload.get("tool_response")
    if isinstance(response, dict):
        if response.get("isError") is True or response.get("is_error") is True:
            return "failed"
        code = response.get("exit_code")
        if isinstance(code, int) and not isinstance(code, bool):
            return "completed" if code == 0 else "failed"
    # Claude's post-success event is distinct from PostToolUseFailure.
    # Codex emits PostToolUse for non-zero exits too, so opaque output is unknown.
    return "unknown"


def ingest(db, connection, envelope):
    payload = envelope.get("payload")
    if not isinstance(payload, dict) or payload.get("hook_event_name") not in PHASES:
        raise ValueError("Unsupported hook event")
    call_id = payload.get("tool_use_id")
    if not isinstance(call_id, str) or not call_id or len(call_id) > 250:
        raise ValueError("Hook has no valid tool-call ID")
    if not isinstance(payload.get("tool_name"), str):
        raise ValueError("Hook has no tool name")
    received = timestamp(envelope.get("received_at"))
    session = resolve_session(db, connection, payload, received)
    if session is None:
        return
    fingerprint = hashlib.sha256(json.dumps([session.id, payload], sort_keys=True).encode()).hexdigest()
    if db.scalar(select(HookObservation.id).where(HookObservation.connection_id == connection.id,
                                                HookObservation.fingerprint == fingerprint)):
        return
    event = db.scalar(select(Event).where(Event.session_id == session.id, Event.kind == "tool_call",
                                         Event.tool_call_id == call_id).order_by(Event.id))
    if event is None:
        text = json.dumps(payload.get("tool_input", {}), ensure_ascii=False)
        event = Event(session_id=session.id, external_id="hook:" + call_id, kind="tool_call", role="tool",
                      text=text, tool_name=payload["tool_name"], tool_call_id=call_id,
                      turn_id=payload.get("turn_id"), action_category=action_category(payload["tool_name"], text),
                      occurred_at=received, payload=payload, transcript_seen=False)
        db.add(event)
        db.flush()
    state = outcome(payload)
    if connection.provider == "claude_code" and payload["hook_event_name"] == "PostToolUse" and state == "unknown":
        state = "completed"
    # Late pre-hooks cannot regress outcomes. Conflicting terminal observations
    # are kept raw and conservatively displayed as unknown.
    previous_terminal = db.scalar(select(HookObservation.id).where(HookObservation.event_id == event.id, HookObservation.phase != "PreToolUse"))
    if previous_terminal is None and state != "requested":
        event.hook_state = state
    elif event.hook_state is None:
        has_result = db.scalar(select(Event.id).where(Event.session_id == session.id,
                Event.kind == "tool_result", Event.tool_call_id == call_id))
        event.hook_state = "unknown" if state == "requested" and has_result else state
    elif state != "requested" and state != event.hook_state:
        event.hook_state = "unknown"
    event.hook_seen_at = max(event.hook_seen_at or received, received)
    session.updated_at = max(session.updated_at, received)
    db.add(HookObservation(connection_id=connection.id, fingerprint=fingerprint, event_id=event.id,
                           phase=payload["hook_event_name"], received_at=received, payload=payload))
    connection.hook_last_seen = max(connection.hook_last_seen or received, received)


def collect(db, connection, limit=100):
    """Commit each observation before removing its durable envelope; replay is safe."""
    queue = queue_path(connection)
    if not queue.is_dir():
        return
    error_file = queue / "observer-error.txt"
    if error_file.exists():
        connection.hook_error = error_file.read_text(encoding="utf-8")[:500]
    for path in itertools.islice(queue.glob("*.json"), limit):
        try:
            if path.stat().st_size > 2 * 1024 * 1024:
                raise ValueError("Oversized hook envelope")
            envelope = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(envelope, dict):
                raise ValueError("Invalid hook envelope")
            ingest(db, connection, envelope)
            db.commit()
            path.unlink(missing_ok=True)
        except (ValueError, TypeError, AttributeError, KeyError):
            db.rollback()
            connection.hook_error = "A hook could not be associated safely. Its envelope is retained as .bad in the local queue."
            path.replace(path.with_suffix(".bad"))
            db.commit()
        except OSError:
            db.rollback()
            connection.hook_error = "Waiting for a readable transcript or queue file; observation will be retried."
            db.commit()
    db.commit()
