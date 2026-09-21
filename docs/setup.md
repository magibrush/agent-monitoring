# Full local setup

[← Relay](../README.md) · [Try the demo](demo.md)

Run Relay on your machine to browse conversations from your installed agents. It reads their transcripts into a local database without changing the source files. Optional live hooks add tool-action review and blocking.

## Requirements

- **Windows with PowerShell or Linux with Bash**.
- [uv](https://docs.astral.sh/uv/) and [Node.js 22.12+ with npm 10+](https://nodejs.org/). uv installs Python 3.11 if needed.
- At least one local agent: **Codex Desktop**, **Codex CLI**, or **Claude Code**, with conversations to import.
- Internet for dependency installation on the first run.
- **Only for live safety review:** a separate API key and billing with a supported provider. An agent subscription does not supply this API access.

Use a separate checkout for Windows and Linux. For WSL, run the Linux commands inside WSL and use transcript paths accessible there.

## 1. Install and start

Clone or download this repository and open a terminal in its folder. If the demo is running, stop it with **Ctrl+C**. Run the command for your OS:

**Windows · PowerShell**

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start.ps1
```

**Linux · Bash**

```bash
bash scripts/start.sh
```

The launcher installs locked dependencies, prepares the database, builds the dashboard, and starts the API and safety workers. It also creates an empty `.secrets/anthropic.key` if missing; leave it empty for monitoring only. An existing key is preserved.

Once startup finishes, open **[Relay at localhost:8000](http://127.0.0.1:8000)**. Keep the terminal open. An empty dashboard is expected until you connect an agent; safety workers can wait for credentials while monitoring continues.

## 2. Connect your agent

1. Open **Connections → Add connection**.
2. Choose an installed agent: **Codex Desktop**, **Codex CLI**, or **Claude Code**.
3. Check the detected source and click **Connect**.
4. Open a session from **Overview** to read it in **Explorer**.

**Monitoring is ready when your conversations appear.** No API key is needed. If nothing appears, start a new agent conversation and let it write activity, then use **Check source** to verify the path.

One connection covers multiple projects and terminals. For another profile, archives, or WSL, use the advanced folder option. See [default source paths](setup-reference.md#agent-sources).

## 3. Enable live safety review (optional)

Follow **[Live safety setup](live-safety.md)** to add an Anthropic key, enable hooks, and optionally turn on blocking. The guide includes restart steps and checks to confirm requests are arriving. Advanced credential options and untested OpenAI support are documented there too.

Live review sends selected action and conversation context to a paid API provider, with limited redaction. Hooks cover only supported tools and are not a sandbox; model judgments can be wrong. Monitoring alone does not require live hooks or model calls.

## Stop and run again

Press **Ctrl+C** in the launcher terminal to stop the API and workers. Run the same start command when you want to return; it synchronizes dependencies and rebuilds the dashboard. Your imported history remains in `data/monitor.db`.

If you enabled blocking, disable it before stopping Relay and restart agent sessions after hook changes. To remove Relay’s hook handlers entirely, use **Disable live hooks** before deleting a connection.

## Local data and troubleshooting

Relay is a single-user local prototype. Conversations are stored in plaintext in `data/monitor.db`; keep the app bound to loopback on your own machine. Stop the API and workers before backing up the database.

- **Setup problem?** [Troubleshooting](setup-reference.md#troubleshooting).
- **Separate processes or frontend development?** [Manual startup](setup-reference.md#manual-startup-and-development).
- **Filters, charts, and recorded outcomes?** [Usage reference](usage-reference.md).
