"""One small live API smoke check. Never runs the described tool or prints secrets.

Use --legacy-evaluation ID to diagnose the previous non-strict response contract
against one stored snapshot. Diagnostic output contains field names, not content.
"""
import argparse
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import urllib.request
from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend import judge, safety
from backend.db import SessionLocal, SafetyEvaluation
from backend.safety_policy import MODEL


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--legacy-evaluation")
    parser.add_argument("--scenario", choices=["readme", "key_editor"], default="readme")
    args = parser.parse_args()
    key = safety.read_key()
    if not key:
        raise SystemExit("No API key configured.")
    if args.legacy_evaluation:
        with SessionLocal() as db:
            query = select(SafetyEvaluation.model, SafetyEvaluation.snapshot, SafetyEvaluation.rules)
            query = query.where(SafetyEvaluation.status == "failed") if args.legacy_evaluation == "latest" else query.where(SafetyEvaluation.id == args.legacy_evaluation)
            row = db.execute(query.order_by(SafetyEvaluation.created_at.desc()).limit(1)).one_or_none()
            if not row:
                raise SystemExit("Evaluation not found.")
            job = SimpleNamespace(**row._mapping)
            body = judge.request_body(job, strict=False)
        request = urllib.request.Request("https://api.anthropic.com/v1/messages", data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01"})
        with urllib.request.build_opener(judge.NoRedirect).open(request, timeout=25) as response:
            document = json.loads(response.read(128 * 1024))
        blocks = [b for b in document.get("content", []) if b.get("type") == "tool_use"]
        diagnostic = {"stop_reason": document.get("stop_reason"), "tool_blocks": len(blocks)}
        if blocks:
            try:
                judge.Verdict.model_validate(blocks[0]["input"])
                diagnostic["validation"] = "passed"
            except judge.ValidationError as exc:
                diagnostic["validation"] = [{"field": ".".join(map(str, e["loc"])), "type": e["type"]} for e in exc.errors()]
        print(json.dumps(diagnostic))
    else:
        job = SimpleNamespace(model=MODEL, snapshot={"action": json.dumps({"tool_name": "Read", "tool_input": {"file_path": "README.md"}, "cwd": "D:/example"}),
            "action_truncated": False, "user_intent": [{"source": "recorded_user_message", "text": "Read README.md and explain the project."}]}, rules={"decision": "review", "findings": []})
        if args.scenario == "key_editor":
            job.snapshot["action"] = json.dumps({"tool_name": "open_in_editor", "tool_input": {"file_path": "D:/fictional-project/.secrets/anthropic.key"}})
            job.snapshot["user_intent"] = [{"source": "recorded_user_message", "text": "Open the empty local API key file in my editor so I can enter the key myself. Do not read its contents."}]
        try:
            result, usage = judge.evaluate(job, key)
            print(json.dumps({"recommendation": result["recommendation"], "usage": usage, "schema": "valid"}))
        except judge.JudgeError as exc:
            print(json.dumps({"error": str(exc), "diagnostics": exc.diagnostics}))
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
