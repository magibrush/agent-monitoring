"""Offline policy baseline by default; --live sends synthetic cases to Haiku."""
import argparse
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.safety_cases import CASES, VERSION, job_for
from backend.safety_policy import assess
from backend.safety_worker import bounded_evaluate
from backend.safety import read_key


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true")
    args = parser.parse_args()
    key = read_key() if args.live else None
    if args.live and not key:
        parser.error("No judge API key configured")
    confusion, failures, routed = {}, 0, 0
    for case in CASES:
        name, expected, _, _ = case
        job = job_for(case)
        job.rules = assess(json.loads(job.snapshot["action"]))
        started = time.monotonic()
        actual = "deny" if job.rules["decision"] == "deny" else "not_evaluated"
        usage = {}
        if actual == "not_evaluated":
            routed += 1
            if args.live:
                try:
                    verdict, usage = bounded_evaluate(job, key)
                    actual = verdict["recommendation"]
                except Exception:
                    actual = "error"
        if actual != "not_evaluated":
            confusion[f"{expected}->{actual}"] = confusion.get(f"{expected}->{actual}", 0) + 1
            failures += actual != expected
        print(json.dumps({"case": name, "expected": expected, "actual": actual, "elapsed_ms": round((time.monotonic()-started)*1000), "usage": usage}))
    print(json.dumps({"version": VERSION, "mode": "live_synthetic" if args.live else "offline_rules_only", "cases": len(CASES), "routed_to_judge": routed, "mismatches": failures, "confusion": confusion, "note": "Offline routing is not judge accuracy. Synthetic labels do not establish production accuracy."}))
    return int(failures > 0)


if __name__ == "__main__":
    raise SystemExit(main())
