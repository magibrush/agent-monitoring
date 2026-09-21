# Relay

**One local dashboard for Codex Desktop, Codex CLI, and Claude Code.** Browse agent conversations, review proposed tool actions, and investigate suspicious activity with the surrounding conversation as evidence.

![Relay dashboard with synthetic agent sessions](docs/images/demo-overview.png)

## Choose your path

| I want to… | Start here |
| --- | --- |
| See what it does | [Screenshots](docs/demo.md#screenshots) · Video coming soon |
| Try it without an agent or API key | [Run the sample demo](#run-the-sample-demo) |
| Connect my own agents | [Full setup](docs/setup.md) |
| Explore the implementation | [Architecture](docs/architecture.md) · [Tests](docs/testing.md) · [Relay Lab](lab/README.md) |

## Run the sample demo

On **Windows with PowerShell**, install [uv](https://docs.astral.sh/uv/) and [Node.js 22.12+ with npm 10+](https://nodejs.org/). Clone or download this repository, open PowerShell in its folder, and run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/demo.ps1
```

The launcher installs dependencies, builds the dashboard, and opens **http://127.0.0.1:8001**. The first run needs internet access; Python 3.11 is installed through uv if needed.

Follow the in-app tour or explore freely:

- **Overview → Explorer:** open a session and read its conversation and tool calls.
- **Safety:** inspect a denied upload, its evidence, and a human-review example.
- **Connections:** see the supported agent sources.

Everything is synthetic. The demo executes no scenario commands, reads no personal transcripts, changes no agent hooks, and makes no model calls. **Reset demo** restores the examples; Ctrl+C stops the server. Restarting also resets the demo. [Options and troubleshooting](docs/demo.md#launch-options).

## Use your own agents

[Setup](docs/setup.md) takes you from transcript monitoring to optional hooks, policies, and live safety review. Browsing transcripts needs no API key. Live review uses paid API calls and sends selected action and conversation context to the configured provider. Anthropic is the default; [OpenAI support](docs/setup.md#optional-openai-credentials-untested) is available but untested with live calls.

Relay is a Windows-focused local prototype. It stores conversations in plaintext. Hooks cover only supported tools, model judgments can be wrong, and an approval does not prove execution succeeded. Keep it on your own machine.

[Usage reference](docs/usage-reference.md) · [All documentation](docs/README.md)
