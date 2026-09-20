"""Fixed entry point for real hook-process tests. Tool arguments are stdin data."""
from scripts.gate_hook import main

if __name__ == "__main__":
    raise SystemExit(main())
