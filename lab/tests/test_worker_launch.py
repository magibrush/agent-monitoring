import os
from pathlib import Path
import subprocess
import sys


def test_managed_worker_spawns_large_evaluations_with_parent_stdin_open(tmp_path):
    root = Path(__file__).resolve().parents[2]
    env = {**os.environ, "DATABASE_URL": "sqlite:///" + (tmp_path / "probe.db").as_posix()}
    process = subprocess.Popen(
        [sys.executable, "-m", "lab.tests.spawn_probe", "--supervise", str(tmp_path)],
        cwd=root, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        # communicate() would close stdin and hide the original Windows deadlock.
        code = process.wait(timeout=22)
        assert code == 0, process.stderr.read().decode() + (tmp_path / "worker.log").read_text(encoding="utf-8")
    finally:
        process.stdin.close()
        if process.poll() is None:
            process.kill()
            process.wait()
