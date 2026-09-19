# Safety policies

Open **Safety → Policies**. Choose **Add rule**; presets on the right fill the form without saving it. A rule answers three questions: **when**, **for which connections**, and **what happens**. Rules can cover all connections (including future ones) or any selected set. Folders are optional for restrictive rules.

## Decisions and matching

- **Block** rejects a matching request.
- **Ask me** sends it straight to human approval without waiting for the judge.
- **Send to judge** requires the ordinary judge path even if a permissive rule also matches.
- **Approve automatically** bypasses the queue and model for verified, scoped direct file reads.

Built-in prohibitions win, followed by Block → Ask me → Send to judge → Approve automatically. A compact priority chain shows Block → Ask me → Send to judge → Approve automatically. Unmatched actions retain the existing judge behavior. Rules stop execution only on connections with blocking enabled; advisory connections record what would have happened. Human approval never silently creates a permanent rule.

## Activities and conditions

| Activity | What matches |
| --- | --- |
| Read files | Supported structured file-read tools; optional folders, extensions and filename patterns |
| Write or edit files | Supported write/edit/patch tool calls; resource filters require a known file target |
| Run shell commands | Known shell execution tools, including Bash, PowerShell, exec and exec_command |
| Detected Git pushes | Visible Git push signals inside known shell commands |
| Sensitive-file access | Recognized sensitive file paths or visible command signals, including .env and credential paths |
| Detected network requests | Known network tools and visible shell network signals |
| Use a specific tool | An exact tool name, useful for custom tools and integrations |

Optional literal command text, exact tool name live under **More conditions**. Enable or disable each rule using its switch in the rules list; this saves a draft change. Filename patterns apply to the basename (e.g. `.env`, `.env.*`, `*.pem`), not the whole path; they are not regular expressions. Extensions and filename patterns combine with AND; alternatives inside each list combine with OR. Connections and folders inside their lists combine with OR.

For direct file operations, folders match the target file. Restrictive rules examine lexical and resolved paths. For shell commands, folders match where the command starts; they do not confine its effects. For mixed activities such as sensitive-file access and specific tools, the same target/working-directory distinction applies.

Git, credential and network detection identifies visible signals, not arbitrary program behavior. It can conservatively match quoted text. Indirect scripts, aliases, encoded commands or unknown tool envelopes may not be recognized. Use an all-shell Ask me rule when all shell execution needs approval, or an exact-tool rule for an integration. Unknown behavior cannot qualify for automatic approval merely because its text looks safe.

Automatic approval supports `Read` and `read_file` with exactly one `path` or `file_path`, plus optional positive integer `offset`/`limit`. Explicit existing folders and selected extensions are required: `.md`, `.rst`, `.txt`, `.py`, `.js`, `.jsx`, `.ts`, `.tsx`, `.css`, `.html`. Hidden/credential-like paths, symlinks/junctions, Relay data, unknown arguments and alternative data streams remain excluded. A filename extension does not prove the content is non-sensitive; scope it deliberately. Shell approval by prefix or substring is not supported.

## Save, test, apply

**Save rule** updates one persistent working draft, preserving other rules. Editing and removing rules do not create a visible version for each click. Removal and discarding use confirmation dialogs. **Review changes** opens a dialog showing added, changed and removed rules against the live set. Draft and Live tabs keep working changes separate from enforcement. **Discard draft** asks once before abandoning all staged changes.

**Simulate past requests** locally replays up to 500 recent non-debug assessments using saved redacted inputs and today's filesystem. It executes no actions and makes no model calls. Results include built-in protections, explicit judge routing, unmatched requests and unavailable evidence. They are a bounded impact preview, not an accuracy score or a reconstruction of historical filesystem state.

Optionally **Start live simulation** records candidate decisions on new requests while the current live rules still apply. This was formerly called a shadow trial. It never independently releases, rejects or pauses an action. Results refresh automatically and summarize up to the latest 1,000 test records for the tested version. Judge disagreements are diagnostic feedback, not ground truth. **Stop live simulation** ends observation. An empty live test is not a prerequisite to applying rules.

**Apply changes** affects only new requests. Simulation is optional: applying a draft without a past-request simulation shows a confirmation. “Don’t ask again in this browser” hides that warning; restore it under Safety settings → Policies. Already paused requests keep their original assessment. A matching automatic approval still needs the normal bound delivery receipt before Relay reports release. **Pause rules** restores built-in checks and ordinary judging while keeping the rules in place with muted styling and struck-through names. **Resume rules** restores that set. History shows applied policies, change details and **Restore as draft**. Test and apply the restored draft to change live protection.

## Architecture and limits

Action normalization (`backend/policy_actions.py`) extracts conservative facts. Deterministic matching and lifecycle (`backend/policies.py`) share those facts with previews and observational tests. Enforcement stays in the existing gate path. Legacy versions preserve their original matcher and remain rollbackable; editing creates the new schema. Migration 0013 adds the working-draft pointer and persisted preview results. Existing unfinished work is adopted once; old snapshots remain stored. Testing freezes an internal snapshot; subsequent edits update the conceptual draft using a new snapshot, stop an outdated live test and invalidate the previous simulation. These internal snapshot IDs are not shown as user-facing versions.

This remains a single-host PoC, not a tamper-resistant boundary. Rules and local-operator audit history are in SQLite, with revision checks to prevent stale-window overwrites. Arbitrary code under the same OS account can bypass application controls. Filesystem checks cannot eliminate a change between assessment and execution. Strong executor isolation, authenticated operators and a separate protected policy store remain future work.

## Manual verification

1. Create **Review Git pushes**, choose two test connections, save and test. Start a live test and confirm current enforcement stays unchanged.
2. Apply it, then submit a harmless test Git push request through a blocking test connection. It should reach human approval with **Policy** as its source; deny the request if you do not intend an actual push.
3. Add **Block sensitive-file access** and check a dummy `.env` path. Confirm a matching action is blocked and other rules remain present.
4. Check an exact-tool rule and a scoped documentation-read approval on synthetic inputs.
5. Restore a prior revision. Verify new requests use it while existing assessments remain unchanged.

## Design review and verification

The system-design review approved the separation of action facts, deterministic matching and rollout, then reviewed the desktop/mobile editor and rule list. Follow-up changes clarified mixed folder scope, made drafts discoverable, exposed approval restrictions before save, distinguished effective preview decisions from custom matches, and removed stale/empty-result clutter. No blocking review findings remain.

Backend and browser regression tests pass, including real hook review/block/judge routing, multi-connection rules, sensitive-file signals, legacy compatibility and the complete draft/test/apply/restore workflow. TypeScript and production build pass. The local API and worker were restarted with no outstanding assessments and no custom policy activated. No external judge calls were made by the tests; these checks establish routing and implementation behavior, not classifier accuracy or production latency.


## Workspace iteration

The workflow follows the separation of workspace edits and published versions used by [Google Tag Manager](https://support.google.com/tagmanager/answer/7059647?hl=en), with an explicit preview/apply boundary comparable to [Terraform's core workflow](https://developer.hashicorp.com/terraform/intro/core-workflow). Presets live inside the rule editor; published history is actionable rather than a raw audit log. Simulation results persist across reloads and stay tied to their exact snapshot; applying an unsimulated draft is an explicit operator choice.

Migration 0013 was applied locally after a SQLite backup with no outstanding assessments. The existing latest draft (8) was preserved; no policy was activated. Desktop/mobile review accepted the layout, and browser tests exercised mobile Save, Test and Apply without forced clicks.

## Inspecting test results

Outcome cards filter the full retained sample. Search by command, session or rule; results paginate in groups of 20. Select a request to compare its recorded assessment with the draft decision, inspect matching rules and priority, and read its saved redacted action. Older previews must be rerun to populate this evidence. Legacy rule expirations remain visible but are no longer offered in the editor. Migration 0014 preserves paused policy sets without activating them.

Debug mode overrides custom policy routing and the judge on new assessments. Built-in prohibitions, incomplete-action checks and deadlines remain enforced. Disabling debug restores the configured custom policies. Existing assessments retain their original decision path.
