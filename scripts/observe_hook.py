"""Dependency-free observer. Never emits decisions; always exits successfully.

One atomic file per delivery avoids concurrent writers and survives Relay downtime.
The queue is capped at 256 MB (approximately, under concurrent producers).
"""
import json
import os
from pathlib import Path
import sys
from datetime import datetime, timezone
from uuid import uuid4

MAX_BYTES = 1024 * 1024


def capture(queue, stream):
    raw = stream.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("Hook payload exceeds 1 MB")
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("Expected hook object")
    queue = Path(queue)
    # Enable/disable is controlled by Relay. Stale provider processes become no-ops.
    if not (queue / "enabled").is_file():
        return
    total = 0
    for file in queue.iterdir():
        if file.suffix in {".json", ".tmp", ".bad"}:
            try:
                total += file.stat().st_size
            except FileNotFoundError:
                pass
        if total > 256 * MAX_BYTES:
            raise ValueError("Hook queue is full; transcript recovery remains available")
    envelope = {"received_at": datetime.now(timezone.utc).isoformat(), "payload": payload}
    pending = queue / (uuid4().hex + ".tmp")
    try:
        with pending.open("x", encoding="utf-8") as output:
            json.dump(envelope, output, ensure_ascii=False)
            output.flush()
            os.fsync(output.fileno())
        pending.replace(pending.with_suffix(".json"))
    finally:
        pending.unlink(missing_ok=True)


def main():
    try:
        capture(sys.argv[1], sys.stdin.buffer)
    except Exception as exc:
        # Diagnostics stay out of provider stdout/stderr, which can affect agents.
        try:
            (Path(sys.argv[1]) / "observer-error.txt").write_text(
                datetime.now(timezone.utc).isoformat() + " " + type(exc).__name__ + ": " + str(exc), encoding="utf-8")
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
