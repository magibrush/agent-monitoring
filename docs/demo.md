# Demo

See the screenshots below, or [launch the sample dashboard](../README.md#run-the-sample-demo). A video walkthrough is coming soon.

## The three-minute tour

The in-app guide walks through a conversation, a denied upload, a human review, and the supported connections. Click the highlighted controls to advance. **Explore freely** or Escape exits; **Restart guided tour** starts again.

All content and decisions are scripted. No agent, API key, or personal data is needed. The demo does not execute commands, collect transcripts, install hooks, or call models. It illustrates the interface, not live detection accuracy.

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

## Launch options

Run from the repository root:

```powershell
# Choose another port and skip opening the browser.
powershell -ExecutionPolicy Bypass -File scripts/demo.ps1 -Port 8002 -NoBrowser

# Restart without reinstalling or rebuilding.
data/demo/venv/Scripts/python.exe -m backend.demo
```

Ctrl+C stops the server. Every launch and **Reset demo** replaces `data/demo/monitor.db`. The demo ignores `DATABASE_URL` and keeps its Python environment in `data/demo/venv`. Run only one demo server or demo browser suite per checkout: they share that database.

| Problem | Fix |
| --- | --- |
| Missing or old runtime | Install uv, Node 22.12+, and npm 10+; reopen PowerShell. |
| Port occupied | Stop the other demo or choose `-Port 8002`. |
| Dependency download failed | Check internet access and rerun the launcher. |

For your own transcripts, stop the demo and follow [setup](setup.md). To test synthetic requests through the actual decision pipeline, use [Relay Lab](../lab/README.md).
