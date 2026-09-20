"""The real worker service, with an out-of-band evaluator in scripted runs."""
import argparse
import json
import os
from pathlib import Path
import threading

from lab.models import RunConfig

ROOT = Path(__file__).resolve().parents[1]


def environment(path, config):
    from uuid import UUID
    path = path.resolve()
    if path.parent != (ROOT / "data/lab").resolve() or str(UUID(path.name)) != path.name:
        raise ValueError("Worker requires a lab-owned run directory.")
    os.environ["DATABASE_URL"] = "sqlite:///" + (path / "relay.db").as_posix()
    os.environ["RELAY_HOOK_QUEUE"] = str(path / "queue")
    if config.mode == "scripted":
        os.environ.pop("ANTHROPIC_API_KEY", None)
        os.environ["RELAY_ANTHROPIC_KEY_FILE"] = str(path / "no-provider-key")


def serve(path, owner_pid):
    config = RunConfig.model_validate_json((path / "config.json").read_text(encoding="utf-8"))
    environment(path, config)
    from backend import safety, safety_worker, judge, incident_analysis
    from backend.db import SessionLocal, Event
    stop = threading.Event()
    from lab.ownership import Owner
    owner = Owner(owner_pid)

    def scripted(job, key):
        with SessionLocal() as db:
            call = db.get(Event, job.event_id).tool_call_id
        # Case metadata is a separate file, never part of the hook or snapshot.
        item = json.loads((path / "cases" / f"{call}.json").read_text(encoding="utf-8"))
        if config.judge_delay_ms:
            stop.wait(config.judge_delay_ms / 1000)
        if config.fault == "unavailable" or config.fault == "retry_once" and job.attempts == 1:
            raise judge.JudgeError("Injected provider unavailability", True)
        expected = item["expected"]
        result = {**expected, "source": "judge", "risk": "low" if expected["severity"] == "low" else "high",
                  "reason": "Scripted response for " + item["title"], "evidence": [], "missing_context": []}
        if item["id"] == "severity-floor":
            result["severity"] = "low"
        return result, {"lab_scripted": True}

    def scripted_analysis(job, key):
        ids = [e["event_id"] for e in job.evidence["events"] if e["flagged"]][:8]
        return {"summary": "Scripted analysis: the recorded action needs attention.",
                "findings": [{"text": "Inspect the assessment and gate receipt for these actions.", "evidence_ids": ids}],
                "recommendations": [{"text": "Confirm the scope against the recorded user request.", "evidence_ids": ids}]}, {"lab_scripted": True}

    if config.mode == "scripted":
        safety.read_key = lambda: "sk-ant-lab-offline-sentinel"
        safety_worker.bounded_evaluate = scripted
        incident_analysis.bounded_evaluate = scripted_analysis
    if not config.analysis:
        incident_analysis.run_one = lambda: False

    def watch_stop():
        while not stop.wait(.2):
            if (path / "stop-worker").exists() or not owner.alive():
                stop.set()
    watcher = threading.Thread(target=watch_stop, daemon=True)
    watcher.start()
    try:
        safety_worker.serve(config.workers, stop=stop)
    finally:
        stop.set()
        watcher.join()
        owner.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--owner-pid", type=int, required=True)
    args = parser.parse_args()
    serve(args.run.resolve(), args.owner_pid)
