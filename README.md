# Relay

One local dashboard for Codex Desktop, Codex CLI, and Claude Code. Browse agent conversations, review proposed tool actions, and investigate suspicious activity with the surrounding context.

## Video walkthrough

[![Watch the Relay video walkthrough](https://img.youtube.com/vi/U9_ka0Od-h0/hqdefault.jpg)](https://www.youtube.com/watch?v=U9_ka0Od-h0)

## Run it yourself

You’ll need **Windows (PowerShell) or Linux (Bash)**, [uv](https://docs.astral.sh/uv/) and [Node.js 22.12+ with npm 10+](https://nodejs.org/). Clone or download this repository. Python 3.11 is installed automatically through uv if needed.

### Just the demo

Explore a guided dashboard with fictional conversations and scripted safety decisions. No coding agent, API key, or personal data needed.

**[Run the demo →](docs/demo.md)**

### Full local application

Connect your installed agents and browse real conversations. Monitoring needs no API key; optional live safety review uses a paid API provider.

**[Set up Relay locally →](docs/setup.md)**

### Relay Lab

Test safety rules and tool-action reviews with synthetic requests, inspect decisions and evidence, or simulate load and failures. Lab exercises the decision pipeline without executing the proposed commands. Simulated runs need only uv, with no coding agent or API key.

**[Run Relay Lab →](lab/README.md)**

## Technical overview

Relay uses React and TypeScript for the dashboard, FastAPI for the local API, and SQLite for storage. Collectors import agent transcripts; optional hooks and background workers evaluate proposed tool actions before they proceed.

[Architecture and trade-offs](docs/architecture.md) · [Testing](docs/testing.md) · [All documentation](docs/README.md)
