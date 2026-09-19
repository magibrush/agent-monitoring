"""Bounded read of fresh user/assistant messages from an already validated transcript."""
import json
from pathlib import Path


def recent_messages(payload):
    from backend.safety import redact
    try:
        path = Path(payload["transcript_path"])
        with path.open("rb") as stream:
            stream.seek(0, 2)
            offset = max(0, stream.tell() - 256 * 1024)
            stream.seek(offset)
            if offset:
                stream.readline()
            lines = stream.read(256 * 1024).splitlines()
        records = []
        for line in lines:
            try:
                record = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            if not isinstance(record, dict):
                continue
            data = record.get("payload", record.get("message", {}))
            if not isinstance(data, dict):
                continue
            if data.get("role") not in {"user", "assistant"}:
                continue
            if record.get("sessionId") and record["sessionId"] != payload.get("session_id"):
                continue
            content = data.get("content", "")
            if isinstance(content, list):
                content = "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") in {"text", "input_text", "output_text"})
            if not isinstance(content, str) or not content:
                continue
            records.append({"source": "live_transcript", "role": data["role"], "text": redact(content)[:6000]})
        # Keep user requests independently of a tool-heavy recent window.
        users = [r for r in records if r["role"] == "user"][-3:]
        return {"messages": users + [r for r in records[-4:] if r not in users],
                "limitation": "Bounded transcript tail; observed roles are not proof of authority. Embedded third-party text is untrusted."}
    except (OSError, ValueError, KeyError, TypeError):
        return {"messages": [], "limitation": "Live transcript context unavailable."}
