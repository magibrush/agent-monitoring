"""Run separately: python -m backend.safety_worker --workers 2."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import logging
import multiprocessing
import signal
import threading
import time
from uuid import uuid4

from backend.db import SessionLocal, SafetyWorker, now
from backend import safety, judge
from backend.safety_budget import attempt_timeout

log = logging.getLogger(__name__)


def _judge_process(channel, job, key):
    try:
        verdict, usage = judge.evaluate(job, key)
        channel.send(("ok", verdict, usage))
    except judge.JudgeError as exc:
        channel.send(("error", str(exc), exc.retryable, exc.diagnostics))
    except Exception:
        channel.send(("error", "Unexpected evaluator failure.", True, {}))
    finally:
        channel.close()


def bounded_evaluate(job, key, target=_judge_process):
    """A socket inactivity timeout alone cannot bound a trickling response."""
    timeout = attempt_timeout(job)
    if timeout <= 0:
        raise judge.JudgeError("Automated evaluation budget exhausted.")
    context = multiprocessing.get_context("spawn")
    reader, writer = context.Pipe(duplex=False)
    process = context.Process(target=target, args=(writer, job, key), daemon=True)
    started = time.monotonic()
    try:
        process.start()
        writer.close()
        if not reader.poll(max(0, timeout - (time.monotonic() - started))):
            raise judge.JudgeError("Judge exceeded its wall-clock budget.", True)
        try:
            result = reader.recv()
        except EOFError:
            raise judge.JudgeError("Judge process stopped before returning a verdict.", True) from None
        if time.monotonic() - started > timeout:
            raise judge.JudgeError("Judge exceeded its wall-clock budget.", True)
        if result[0] == "error":
            raise judge.JudgeError(result[1], result[2], result[3])
        return result[1], result[2]
    finally:
        if process.pid:
            if process.is_alive():
                process.terminate()
            process.join(timeout=2)
            if process.is_alive():
                process.kill(); process.join(timeout=2)
        reader.close(); writer.close()


def run_one(factory=SessionLocal, evaluator=None, blocking_only=False):
    key = safety.read_key()
    job = safety.claim(factory, blocking_only=blocking_only, debug_only=not key)
    if job is None:
        return False
    started = time.monotonic()
    try:
        if job.rules.get("decision") == "deny":
            verdict, usage = {"recommendation": "deny", "risk": "high", "source": "rules", "reason": "Explicit policy prohibition.", "evidence": [], "missing_context": []}, {}
        elif job.debug_result:
            from backend.safety_debug import verdict as simulated_verdict
            verdict, usage = simulated_verdict(job), {}
        else:
            verdict, usage = (evaluator or bounded_evaluate)(job, key)
        safety.finish(factory, job, result=verdict, usage=usage, latency_ms=int((time.monotonic() - started) * 1000))
    except judge.JudgeError as exc:
        safety.finish(factory, job, error=str(exc), retryable=exc.retryable, diagnostics=exc.diagnostics, latency_ms=int((time.monotonic() - started) * 1000))
    except Exception:
        safety.finish(factory, job, error="Unexpected evaluator failure.", retryable=True)
    return True


def worker_lanes(workers):
    # Shared lanes also prioritize blocking work. Reserved lanes never run shadow.
    return [True] * max(1, workers - 1) + ([False] if workers > 1 else [])


def serve(workers=2):
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    def loop(blocking_only):
        while not stop.is_set():
            try:
                worked = run_one(blocking_only=blocking_only)
            except Exception:
                log.error("Safety worker storage unavailable; retrying.")
                worked = False
            stop.wait(0.1 if worked else 0.25)
    worker_id = str(uuid4())
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(loop, lane) for lane in worker_lanes(workers)]
        try:
            while not stop.is_set():
                try:
                    with SessionLocal() as db:
                        from backend.safety_debug import settings
                        configured = safety.read_key() or settings(db)["enabled"]
                        db.merge(SafetyWorker(id=worker_id, heartbeat_at=now(), status=("blocking_only" if workers == 1 else "ready") if configured else "waiting_for_key"))
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
