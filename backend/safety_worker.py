"""Run separately: python -m backend.safety_worker --workers 2."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import logging
import signal
import threading
import time
from uuid import uuid4

from backend.db import SessionLocal, SafetyWorker, now
from backend import safety, judge

log = logging.getLogger(__name__)


def run_one(factory=SessionLocal, evaluator=judge.evaluate):
    key = safety.read_key()
    if not key:
        return False
    job = safety.claim(factory)
    if job is None:
        return False
    started = time.monotonic()
    try:
        verdict, usage = evaluator(job, key)
        safety.finish(factory, job, result=verdict, usage=usage, latency_ms=int((time.monotonic() - started) * 1000))
    except judge.JudgeError as exc:
        safety.finish(factory, job, error=str(exc), retryable=exc.retryable, diagnostics=exc.diagnostics, latency_ms=int((time.monotonic() - started) * 1000))
    except Exception:
        safety.finish(factory, job, error="Unexpected evaluator failure.", retryable=True)
    return True


def serve(workers=2):
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    def loop():
        while not stop.is_set():
            try:
                worked = run_one()
            except Exception:
                log.error("Safety worker storage unavailable; retrying.")
                worked = False
            stop.wait(0.1 if worked else 0.25)
    worker_id = str(uuid4())
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(loop) for _ in range(workers)]
        try:
            while not stop.is_set():
                try:
                    with SessionLocal() as db:
                        db.merge(SafetyWorker(id=worker_id, heartbeat_at=now(), status="ready" if safety.read_key() else "waiting_for_key"))
                        db.commit()
                except Exception:
                    log.error("Safety worker heartbeat could not be saved; retrying.")
                stop.wait(5)
        finally:
            stop.set()
            for future in futures:
                future.result()
            with SessionLocal() as db:
                record = db.get(SafetyWorker, worker_id)
                if record:
                    db.delete(record)
                    db.commit()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workers", type=int, choices=range(1, 9), default=2)
    serve(parser.parse_args().workers)
