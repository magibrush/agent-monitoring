# Run the demo

[← Relay](../README.md) · [Full local setup](setup.md)

Try the dashboard with fictional conversations and scripted safety decisions. No coding agent, API key, or personal data is needed. The demo does not read your transcripts, change agent hooks, execute scenario commands, or call models.

## Requirements

- **Windows (PowerShell) or Linux (Bash)**.
- [uv](https://docs.astral.sh/uv/) and [Node.js 22.12+ with npm 10+](https://nodejs.org/).
- Internet for the first run. uv installs Python 3.11 if needed.

## Start

Clone or download the repository and open a terminal in its folder. Run the command for your OS:

**Windows · PowerShell**

```powershell
powershell -ExecutionPolicy Bypass -File scripts/demo.ps1
```

**Linux · Bash**

```bash
bash scripts/demo.sh
```

The launcher installs dependencies, builds the dashboard, and opens **[the demo at localhost:8001](http://127.0.0.1:8001)**. Follow the in-app tour or explore freely. **Ctrl+C** stops the server; restarting or **Reset demo** restores the examples.

**Ready for your own agents?** Stop the demo and follow [full local setup](setup.md).

## The three-minute tour

The in-app guide walks through a conversation, a denied upload, a human review, and the supported connections. Click the highlighted controls to advance. **Explore freely** or Escape exits; **Restart guided tour** starts again.

The demo illustrates the interface, not live detection accuracy.

## Launch options

Run from the repository root. Windows (PowerShell):

```powershell
# Choose another port and skip opening the browser.
powershell -ExecutionPolicy Bypass -File scripts/demo.ps1 -Port 8002 -NoBrowser

# Restart without reinstalling or rebuilding.
data/demo/venv/Scripts/python.exe -m backend.demo
```

Linux (Bash):

```bash
# Choose another port and skip opening the browser.
bash scripts/demo.sh --port 8002 --no-browser

# Restart without reinstalling or rebuilding.
data/demo/venv/bin/python -m backend.demo
```

Ctrl+C stops the server. Every launch and **Reset demo** replaces `data/demo/monitor.db`. The demo ignores `DATABASE_URL` and keeps its Python environment in `data/demo/venv`. Run only one demo server or demo browser suite per checkout: they share that database.

| Problem | Fix |
| --- | --- |
| Missing or old runtime | Install uv, Node 22.12+, and npm 10+; reopen your terminal. |
| Port occupied | Stop the other demo or choose `-Port 8002` (PowerShell) / `--port 8002` (Bash). |
| Dependency download failed | Check internet access and rerun the launcher. |

For your own transcripts, stop the demo and follow [setup](setup.md). To test synthetic requests through the actual decision pipeline, use [Relay Lab](../lab/README.md).

## Screenshots

### Overview

Compare activity across agents and open a conversation.

![Relay dashboard with four fictional sessions](images/demo-overview.png)

### Investigation

Read the concern, decision, and cited conversation evidence together.

![Denied upload with scripted analysis and conversation evidence](images/demo-incident.png)

### Connections

Connect Codex Desktop, Codex CLI, or Claude Code. These demo sources stay paused.

![Fictional provider connections](images/demo-connections.png)
