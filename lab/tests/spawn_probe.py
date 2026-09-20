"""Offline child process used by the worker launch regression test."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace


def respond(channel, job, key):
    channel.send(("ok", {"recommendation": "allow"}, {}))
    channel.close()


def evaluate(index):
    from backend.safety_worker import bounded_evaluate
    result, _ = bounded_evaluate(SimpleNamespace(
        snapshot={"action": "x" * (index * 12000)}, mode="shadow"),
        "synthetic", target=respond)
    assert result["recommendation"] == "allow"


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--supervise", type=Path)
    parser.add_argument("--run", type=Path)
    parser.add_argument("--owner-pid", type=int)
    args = parser.parse_args()
    if args.supervise:
        from lab.runner import launch_worker
        child = launch_worker(args.supervise, module="lab.tests.spawn_probe")
        try:
            assert child.wait(timeout=15) == 0
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
    else:
        from lab.ownership import Owner
        owner = Owner(args.owner_pid)
        try:
            assert owner.alive()
            with ThreadPoolExecutor(max_workers=2) as pool:
                list(pool.map(evaluate, range(1, 5)))
            assert owner.alive()
        finally:
            owner.close()
