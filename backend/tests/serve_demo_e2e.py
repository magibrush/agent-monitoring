"""Serve the guided tour using a separate, disposable demo database."""
import os
from pathlib import Path

os.environ["RELAY_DEMO"] = "1"
from backend import runtime

runtime.DEMO_DB = Path(__file__).resolve().parents[2] / "data" / "e2e-demo.db"

if __name__ == "__main__":
    from backend.demo import main
    main()
