"""Opt-in synchronous local rules gate. No API dependency and no approvals.

Exit 2 denies a covered pre-tool call. A pass emits nothing, preserving native
permissions. Launch failures and uncovered tools remain outside this boundary.
"""
import io
import json
from pathlib import Path
import sys
import hashlib
import time
from datetime import datetime, timedelta, timezone
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.safety_policy import assess, POLICY_VERSION
from scripts.observe_hook import capture, MAX_BYTES
from backend.providers import PROVIDERS, codex_source

WAIT_SECONDS = 60


def receipt(queue, request, digest, decision):
    directory = queue / "receipts"
    directory.mkdir(exist_ok=True)
    pending = directory / (request["id"] + ".tmp")
    pending.write_text(json.dumps({"id": request["id"], "input_hash": digest, "decision": decision,
        "returned_at": datetime.now(timezone.utc).isoformat()}), encoding="utf-8")
    pending.replace(directory / (request["id"] + ".json"))


def await_decision(queue, request, digest, started):
    reply = queue / "replies" / (request["id"] + ".json")
    while time.monotonic() - started < WAIT_SECONDS:
        if reply.exists():
            if reply.stat().st_size > 16000:
                raise ValueError("Oversized decision")
            decision = json.loads(reply.read_text(encoding="utf-8"))
            if decision.get("id") != request["id"] or decision.get("input_hash") != digest or decision.get("deadline") != request["deadline"]:
                raise ValueError("Mismatched decision")
            if time.monotonic() - started >= WAIT_SECONDS or datetime.now(timezone.utc) >= datetime.fromisoformat(request["deadline"]):
                break
            value = decision.get("decision")
            if value not in {"pass", "deny", "error", "expired"}:
                raise ValueError("Invalid decision")
            receipt(queue, request, digest, value)
            return value
        time.sleep(0.1)
    receipt(queue, request, digest, "expired")
    return "expired"


def matches_connection(payload, provider, root):
    """Shared Codex profiles install handlers for both creation provenances."""
    value = payload.get("transcript_path")
    if not isinstance(value, str) or not Path(value).is_absolute():
        raise ValueError("Missing transcript identity")
    path = Path(value).resolve()
    if not path.is_relative_to(Path(root).resolve()):
        return False
    if path.suffix != ".jsonl":
        raise ValueError("Invalid transcript path")
    if provider == "claude_code":
        return True
    with path.open("rb") as stream:
        line = stream.readline(MAX_BYTES + 1)
    if len(line) > MAX_BYTES or not line.endswith(b"\n"):
        raise ValueError("Incomplete transcript identity")
    record = json.loads(line)
    if record.get("type") != "session_meta" or not isinstance(record.get("payload"), dict):
        raise ValueError("Invalid transcript identity")
    source = codex_source(record["payload"])
    if source is None:
        raise ValueError("Unknown transcript provenance")
    return source == PROVIDERS[provider].source


def main():
    started = time.monotonic()
    try:
        queue = Path(sys.argv[1])
        # Stale handler after disable/delete is inert.
        if not (queue / "enabled").is_file() or not (queue / "gate-enabled").is_file():
            return 0
        raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError("Oversized input")
        payload = json.loads(raw)
        if not isinstance(payload, dict) or payload.get("hook_event_name") != "PreToolUse":
            raise ValueError("Expected pre-tool input")
        if not isinstance(payload.get("tool_name"), str) or not isinstance(payload.get("tool_input"), dict):
            raise ValueError("Invalid tool input")
        if len(sys.argv) >= 4 and not matches_connection(payload, sys.argv[2], sys.argv[3]):
            return 0
        result = assess(payload)
        requested_at = datetime.now(timezone.utc)
        request = {"id": str(uuid4()), "requested_at": requested_at.isoformat(), "deadline": (requested_at + timedelta(seconds=WAIT_SECONDS)).isoformat()}
        action = {"tool_name": payload["tool_name"], "tool_input": payload["tool_input"], "cwd": payload.get("cwd")}
        digest = hashlib.sha256(json.dumps(action, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        gate = {"decision": "deny" if result["decision"] == "deny" else "pass",
                "policy_version": POLICY_VERSION, "findings": result["findings"]}
        # A failure to record the gate's action also denies; never silently pass.
        if gate["decision"] == "deny":
            gate["returned_at"] = datetime.now(timezone.utc).isoformat()
        capture(queue, io.BytesIO(raw), gate=gate if gate["decision"] == "deny" else None, request=request)
        if gate["decision"] == "deny":
            print("Relay policy denied this action: " + "; ".join(f["reason"] for f in result["findings"]), file=sys.stderr)
            return 2
        decision = await_decision(queue, request, digest, started)
        if decision == "pass":
            return 0
        print("Relay blocked this action: " + ("evaluation or human approval deadline expired; submit a new request" if decision == "expired" else "evaluation failed" if decision == "error" else "denied by the judge or human reviewer") + ". Inspect the safety verdict in Relay.", file=sys.stderr)
        return 2
    except Exception:
        print("Relay gate could not validate or record this action. Retry after checking the local gate configuration.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
