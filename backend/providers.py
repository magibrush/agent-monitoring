"""Supported integrations. Legacy provider IDs remain stable on disk."""
from dataclasses import dataclass
import os
from pathlib import Path


@dataclass(frozen=True)
class Provider:
    label: str
    source: str
    adapter: str


PROVIDERS = {
    "codex": Provider("Codex Desktop", "desktop", "codex"),
    "codex_cli": Provider("Codex CLI", "cli", "codex"),
    "claude_code": Provider("Claude Code", "claude_code", "claude_code"),
}


def default_path(provider):
    if PROVIDERS[provider].adapter == "claude_code":
        return Path(os.getenv("CLAUDE_CONFIG_DIR", str(Path.home() / ".claude"))) / "projects"
    if PROVIDERS[provider].adapter == "codex":
        return Path(os.getenv("CODEX_HOME", str(Path.home() / ".codex"))) / "sessions"
    raise ValueError("Unsupported integration")


def codex_source(metadata):
    """Classify creation provenance, never the most recent client to resume it."""
    origin = str(metadata.get("originator", "")).lower()
    source = metadata.get("source")
    if origin == "codex desktop":
        return "desktop"
    # Source describes the interface; originator labels change across releases.
    if isinstance(source, str) and source in {"cli", "exec"}:
        return "cli"
    cli_source = source in (None, "cli", "exec") or (isinstance(source, dict) and "subagent" in source)
    if origin in {"codex_cli_rs", "codex-tui"} and cli_source:
        return "cli"
    return None
