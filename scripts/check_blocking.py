"""Live end-to-end gate check using an isolated synthetic connection.

Requires a running Relay server/worker and API key. Sends synthetic README task
metadata to Haiku. The proposed read is never executed. Removes the test connection.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    args = parser.parse_args()
    def api(path, data=None, method=None):
        request = urllib.request.Request(args.base_url + "/api" + path, data=json.dumps(data).encode() if data is not None else None,
            headers={"Content-Type": "application/json"}, method=method)
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)
    identity = str(uuid4())
    root = ROOT / "data" / "blocking-smoke" / identity / "sessions"
    root.mkdir(parents=True)
    path = root / "synthetic.jsonl"
    stamp = datetime.now(timezone.utc).isoformat()
    path.write_text("\n".join(json.dumps(r) for r in [
        {"type": "session_meta", "timestamp": stamp, "payload": {"id": identity, "originator": "codex-tui", "source": "cli"}},
        {"type": "response_item", "timestamp": stamp, "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Read README.md and summarize the project. This is a synthetic integration check."}]}}
    ]) + "\n", encoding="utf-8")
    connection = api("/connections", {"name": "Synthetic blocking verification", "provider": "codex_cli", "path": str(root)})
    process = None
    try:
        api(f"/connections/{connection['id']}/sync", method="POST")
        api(f"/connections/{connection['id']}/hooks", {"enabled": True, "gate_enabled": True}, "PATCH")
        queue = ROOT / "data" / "hook-queue" / connection["id"]
        process = subprocess.Popen([sys.executable, str(ROOT / "scripts/gate_hook.py"), str(queue), "codex_cli", str(root)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        payload = {"session_id": identity, "transcript_path": str(path), "cwd": str(root), "hook_event_name": "PreToolUse",
            "tool_use_id": "synthetic-read", "tool_name": "Read", "tool_input": {"file_path": "README.md"}}
        process.stdin.write(json.dumps(payload).encode()); process.stdin.close()
        started = time.monotonic()
        # Observe actual waiting rather than assuming a synchronous wrapper works.
        time.sleep(.2)
        held = process.poll() is None
        code = process.wait(timeout=70)
        assert process.stdout.read() == b"", "Gate must preserve native permissions."
        records = []
        for _ in range(30):
            records = api(f"/safety/actions?connection={connection['id']}")["items"]
            if records and records[0]["evaluation"]["returned_at"]:
                break
            time.sleep(.2)
        evaluation = records[0]["evaluation"] if records else {}
        outcome = {"held_before_decision": held, "exit_code": code, "seconds": round(time.monotonic() - started, 2),
            "mode": evaluation.get("mode"), "decision": evaluation.get("decision"),
            "receipt_recorded": bool(evaluation.get("returned_at")), "error": evaluation.get("error")}
        print(json.dumps(outcome))
        return 0 if held and code == 0 and evaluation.get("decision") == "pass" and evaluation.get("returned_at") else 1
    finally:
        if process and process.poll() is None:
            process.kill(); process.wait()
        api(f"/connections/{connection['id']}/hooks", {"enabled": False}, "PATCH")
        api(f"/connections/{connection['id']}", method="DELETE")


if __name__ == "__main__":
    raise SystemExit(main())
