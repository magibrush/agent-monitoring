# Relay

Relay lets you monitor **Codex Desktop, Codex CLI, and Claude Code** in one local dashboard. Browse conversations and tool calls, review proposed actions, and investigate safety concerns.

## 1. Prerequisites

These instructions use **Windows and PowerShell**. Install:

- **Python 3.11+** and [uv](https://docs.astral.sh/uv/).
- **Node.js 22.12+** and **npm 10+**.
- At least one supported coding agent, with a local conversation to import.
- An **Anthropic API key** with API credit and access to Claude Haiku for live safety evaluation. OpenAI is also supported, but has not been tested with live API calls. Anthropic is recommended.

You can use monitoring without a judge API key; skip steps 3 and 6 if you only want to browse agent activity.

## 2. Install Relay

Clone or download this repository. Open PowerShell in the project folder and run:

```powershell
uv sync --locked
Set-Location frontend
npm ci
Set-Location ..
```

## 3. Add your API key

**Without an API key:** you can still browse conversations, search tool calls, and view activity and token usage. Skip this step, continue to [Start Relay](#4-start-relay), and leave live safety review disabled. To try safety scenarios without paid model calls, use [Relay Lab with simulated responses](#7-try-relay-lab-optional). You can add a key later to enable live model evaluation.

For live safety evaluation, create a folder named `.secrets` in the project folder. Inside it, create **`anthropic.key`** and paste your Anthropic API key as its only content. Save it with that exact name, not `anthropic.key.txt`.

```text
agent-monitoring/
  .secrets/
    anthropic.key
```

This file is ignored by Git. Live evaluation uses paid Anthropic API calls and sends action details and selected conversation context to Anthropic. Your coding-agent subscription does not replace this API key.

For OpenAI, set `RELAY_JUDGE_PROVIDER=openai` before starting Relay and its worker, and save the key in `.secrets/openai.key` or set `OPENAI_API_KEY`. This selects OpenAI for both judgments and incident analysis. **OpenAI support has not been tested with live API calls; Anthropic is recommended.** See [OpenAI setup](docs/setup.md#optional-openai-credentials-untested).

Already using `ANTHROPIC_API_KEY`? Relay also accepts that environment variable; it takes precedence over the file. See [credential options](docs/setup.md#optional-anthropic-credentials).

## 4. Start Relay

From the project folder:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start.ps1
```

This builds the dashboard, prepares the database, and starts both Relay and its safety worker. You do not need to start them separately.

Open **[http://127.0.0.1:8000](http://127.0.0.1:8000)**. Keep this terminal open while using Relay. Press **Ctrl+C** to stop; use the same command to start it again.

## 5. Connect your coding agent

1. Open **Connections → Add connection**.
2. Select **Codex Desktop**, **Codex CLI**, or **Claude Code**.
3. Confirm the detected transcript folder and click **Connect**.
4. Open **Overview** to see imported activity, or **Explorer** to read a conversation.

New activity appears as your agent writes its transcripts. If no sessions appear, start a conversation in the selected agent and check the connection's source folder.

## 6. Enable live safety review

With your API key saved and Relay running:

1. Open **Safety → Settings → Protection by connection**.
2. Click **Configure** for your connection, select **Enable blocking Haiku evaluation**, and click **Enable live hooks** (or **Save hook settings** if hooks are already installed).
3. Restart your agent sessions and review/trust the Codex handler if prompted.
4. Ask the agent to perform a harmless action, such as reading a project file. Check that Relay receives the action and shows its assessment in **Safety**.
5. If an action needs your decision, use **Approve** or **Deny** under **Safety → Needs your decision**. Keep the Relay tab open while working.

Covered actions can wait up to 60 seconds, including human review. If the key or worker is unavailable, requests can expire or be blocked. Relay is a local prototype with limited hook coverage, not a guarantee of agent safety. See [review behavior and limits](docs/human-review.md).

## 7. Try Relay Lab (optional)

The Lab tests synthetic scenarios without executing their commands. In a second PowerShell terminal, from the project folder:

```powershell
uv run --locked python -m lab.server
```

Open **[http://127.0.0.1:8010](http://127.0.0.1:8010)**. Choose **Custom request**, keep **Simulated responses**, and click **Test request**. Open the result to inspect its evidence. This mode needs no API key and uses separate test data. Press **Ctrl+C** in the Lab terminal to stop it.

## More information

- [Setup help and troubleshooting](docs/setup.md)
- [Architecture and components](docs/architecture.md)
- [Policies](docs/policies.md), [detailed usage](docs/usage-reference.md), and [Lab guide](lab/README.md)
- [Tests and CI](docs/testing.md)

Relay stores conversation data locally in plaintext. Keep it on your own machine and do not expose it to the public internet. See [data handling and limitations](docs/setup.md).

## Video demo

*Video walkthrough coming soon.*

<!-- Replace this placeholder with the video link or an embedded recording when available. -->

Until then, see the [guided demo and screenshots](docs/demo.md).
