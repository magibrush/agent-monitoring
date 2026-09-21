"""Process-wide runtime mode. Demo storage never uses DATABASE_URL."""
import os
from pathlib import Path

DEMO = os.getenv("RELAY_DEMO") == "1"
DEMO_DB = Path(__file__).resolve().parents[1] / "data" / "demo" / "monitor.db"


def demo_database_url():
    return "sqlite:///" + DEMO_DB.as_posix()
