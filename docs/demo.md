# Guided demo

## The three-minute tour

Relay brings activity from multiple coding agents into one dashboard, then links concerning tool requests to the conversation that explains them. You can view the screenshots below without installing anything. A video walkthrough is still a release-preparation item.

For the interactive version, run `powershell -ExecutionPolicy Bypass -File scripts/demo.ps1` from the repository root. Windows, uv, Node.js 22.12+, and npm 10+ are required. The launcher uses Python 3.11 through uv, installs locked dependencies, and opens **http://127.0.0.1:8001**. No coding agent or API key is needed; the first build requires internet access.

The first visit starts a spotlight tour: the surrounding UI dims, the relevant control is highlighted, and a coaching card explains the next interaction. Navigation steps advance only after you use the actual application control.

1. **Overview:** inspect the highlighted activity totals, then continue. The tour scrolls to the sessions table.
2. **Open a session:** click the highlighted **Count customer records locally** session. Explorer opens its real conversation view.
3. **Read and decide:** inspect the user's local-only request and the proposed upload, then answer the allow/deny question. Use **Read conversation** to move the coaching card aside, then **Show guide** to answer. Answers provide feedback without changing the saved decision.
4. **Investigate:** click **Safety** in the app navigation, then the highlighted upload incident. Inspect the scripted analysis and cited evidence. Only cited records have evidence numbers; surrounding messages are labeled **Context**.
5. **Compare human review:** choose **Compare another incident**, then click the highlighted force-push incident. The guide explains why the command needs permission and highlights **review requested** and **Block confirmed** on the tool call. The recorded human decision was a denial; no technical details need to be expanded.
6. **Connections and free exploration:** click **Connections** in the app navigation, then **Finish and explore**. The overlay disappears and the application is yours to explore. Dismiss an incident, search conversations, or inspect another action.

Use **Explore freely**, the close button, or Escape to exit at any point. **Restart guided tour** returns to Overview. **Reset demo** restores sample data and starts the tour again. Completing or exiting the tour is remembered for the current browser tab, so refreshing does not interrupt free exploration.

All commands are inert data. All assessments, analysis, and execution records are scripted. This demonstrates the review interface, not live model accuracy or real blocking. Demo mode disables transcript discovery, collection, hook setup, policy changes, and model calls, including when credentials already exist. Sample connections remain paused by design. The normal monitoring database is not used.

## Launch options

```powershell
# Use another port, or leave the browser closed.
powershell -ExecutionPolicy Bypass -File scripts/demo.ps1 -Port 8002 -NoBrowser

# After dependencies and the dashboard are built, restart quickly.
data/demo/venv/Scripts/python.exe -m backend.demo
```

Ctrl+C stops the server. Each launch resets **only** `data/demo/monitor.db`; the in-app reset does the same. Do not keep edits here that you want to retain. The launcher keeps its Python environment in `data/demo/venv`, separate from the development environment. The demo ignores `DATABASE_URL`. Run one demo server per checkout; its database is shared by demo launches and demo browser tests.

If the launcher reports an old Node version, install a compatible version and reopen PowerShell. If the port is occupied, stop the existing demo or choose another port. If dependencies fail to download, check network access and rerun the launcher. Standard Node and uv installations are used; the demo launcher does not search for developer-specific runtimes.

To connect your real agent, stop the demo and follow [normal setup](setup.md). That application uses port 8000 and separate storage. [Relay Lab](../lab/README.md) is the next step for experimenting with scripted pipeline scenarios.

## Screenshots

These captures come from the main-dashboard demo described above. All visible activity, assessments, analysis, and token counts are synthetic; no live model was called.

![Guided spotlight tour highlighting the real Overview controls](images/demo-guided-tour.png)

![Sample dashboard with four fictional sessions across three providers](images/demo-overview.png)

![Denied upload investigation with scripted analysis and conversation evidence](images/demo-incident.png)

![Sample provider cards showing fictional agent sources](images/demo-connections.png)

## Key-free demo: inspect a synthetic safety decision

This path needs Python 3.11+ and uv, but no coding agent, API key, or Node installation. It demonstrates Relay Lab; it does not populate the main Relay dashboard.

From the repository root:

```powershell
uv sync --locked
uv run --locked python -m lab.server
```

1. Open **http://127.0.0.1:8010** and select **Custom request**.
2. Keep **Evaluate with → Simulated responses**.
3. Use the prefilled **Unexpected data transfer** example. Its user request asks for a local count; the proposed tool request describes uploading a file to an example endpoint.
4. Keep the simulated verdict **Deny**, severity **critical**, and suspicious flag selected. Click **Test request**.
5. Wait for completion. Inspect the assessment, gate receipt, and check result. The simulated judge is configured to deny; this does not establish that a live model would detect the issue.
6. Open the action row to inspect the recorded payload and conversation. Use **Export JSON** to download the report.

The command in the example is data only. The Lab never executes it. Each run gets a separate database under `data/lab/`; existing monitoring data and provider hook settings are not used. Stop the server with Ctrl+C when finished.

### Second example: a routine read

Create a new **Custom request** with:

| Field | Value |
| --- | --- |
| Test name | Read the login source |
| User's request | Explain the login source file. |
| Tool name | `Read` |
| Tool input | `{"file_path":"src/login.ts"}` |
| Simulated verdict | Allow |
| Severity | Low |
| Flag as suspicious | Off |

Run it and inspect the allow assessment and delivered receipt. The file is fictional; the Lab does not read it. An allowed request still does not mean the tool ran.

For policy examples, switch to **Scenarios**. Keep **Simulated responses** and start with a small selection. Leave fault injection and incident analysis off for the first walkthrough. Human review is simulated by the Lab; the main app's actual human-review workflow is separate.

## Main dashboard walkthrough

Follow [setup](setup.md) and add a supported local agent connection. This path uses your own transcripts, so avoid recording it with private conversations visible.

1. **Overview:** show sessions, messages, actions, and the shared time range.
2. **Explorer:** open one session, search its records, and inspect a tool request and result.
3. **Safety:** explain how pending human reviews differ from recorded action history. An empty queue is normal without configured hooks and new covered requests.
4. **Policies:** inspect a preset and the draft/apply workflow. Applying rules is an explicit configuration change.
5. **Incidents:** explain evidence and resolution using existing suitable examples, if available. Resolving an incident does not approve a tool request.

For a recording that includes real blocking, first configure the optional worker, credentials, and hooks as documented in setup. Use a harmless action and a scoped review policy. Do not depend on a model producing a particular verdict during a live presentation.

## Suggested 90-second presentation

- **0–15 seconds:** “Relay helps me observe coding-agent activity and inspect decisions about proposed tool actions.”
- **15–40 seconds:** show Overview and a conversation in Explorer using sanitized sample content.
- **40–65 seconds:** show the synthetic deny scenario in Lab, open its evidence, and distinguish a decision from execution.
- **65–90 seconds:** explain recoverable ingestion, durable decision deadlines, and one limitation: local SQLite contention or imperfect model judgments.

Before publishing additional screenshots or video, use only synthetic content and inspect every visible path, name, token, and conversation. Use the main-dashboard demo above for repeatable recordings. A public walkthrough recording remains a release-preparation item.
