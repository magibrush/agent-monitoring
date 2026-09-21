# Safety policies

Open **Safety → Policies → Add rule**. Pick a preset or choose an activity, connections, conditions, and decision. **Save rule** stages a draft; **Apply changes** activates it for new requests.

## Decisions

| Decision | Effect |
| --- | --- |
| Block | Reject the request. |
| Ask me | Request human approval without calling the judge. |
| Send to judge | Require model evaluation, even if an approval rule also matches. |
| Approve automatically | Bypass model evaluation for verified, scoped direct file reads. |

Priority: **built-in prohibitions → Block → Ask me → Send to judge → Approve automatically**. Unmatched actions follow normal judging. Rules stop execution only on connections with blocking enabled; shadow connections record advisory decisions. Human approval never creates a permanent rule.

## Conditions and boundaries

Rules can cover all connections, including future ones, or selected connections.

| Activity | Matches |
| --- | --- |
| Read files | Supported structured reads; optional folders, extensions, and filename patterns |
| Write or edit files | Supported writes, edits, and patches; resource filters require a known file target |
| Run shell commands | Known shell tools, including Bash, PowerShell, exec, and exec_command |
| Detected Git pushes | Visible Git push signals in known shell commands |
| Sensitive-file access | Recognized paths or command signals, including `.env` and credential paths |
| Detected network requests | Known network tools and visible shell network signals |
| Use a specific tool | An exact tool name |

**More conditions** includes literal command text and exact tool names. Filename patterns match basenames (`.env.*`, `*.pem`), not full paths or regular expressions. Extensions and patterns combine with AND; alternatives within a list combine with OR.

For direct file operations, folders match the target file; restrictive rules check lexical and resolved paths. For shell commands, folders match the starting directory, not every affected path. Git, network, and credential detection can match quoted text or miss aliases, scripts, encoded commands, and unknown tool formats. Use an all-shell Ask me rule if every shell command needs review.

### Automatic file-read approval

Supported tools are `Read` and `read_file`, with exactly one `path` or `file_path` and optional positive integer `offset`/`limit`. Existing folders and selected extensions are required: `.md`, `.rst`, `.txt`, `.py`, `.js`, `.jsx`, `.ts`, `.tsx`, `.css`, `.html`.

Hidden or credential-like paths, symlinks/junctions, Relay data, unknown arguments, and alternative data streams are excluded. Extensions do not prove content is non-sensitive. Shell approval by prefix or substring is unsupported. Filesystem checks cannot eliminate changes between assessment and execution.

## Test and apply

Edits, switches, and removals accumulate in one persistent draft. **Review changes** compares it with live rules; **Discard draft** abandons it.

| Option | What it does |
| --- | --- |
| Simulate past requests | Checks up to 500 recent non-debug assessments using saved redacted inputs and today's filesystem; no commands or model calls. |
| Start live simulation | Records candidate decisions on new requests while current rules still apply; displays up to the latest 1,000 records. |
| Apply changes | Uses the draft for new requests. Already paused requests retain their original assessment. |
| Pause / Resume rules | Temporarily uses built-in checks and ordinary judging, then restores the saved rules. |
| History → Restore as draft | Copies an applied version into a draft for review and application. |

Simulation is optional. Applying without a past simulation asks for confirmation; the browser can remember your preference, resettable in Safety settings. Simulations preview rule impact, not model accuracy or historical filesystem state. Judge disagreements are diagnostic feedback, not ground truth.

Filter results by outcome or search by command, session, or rule. Select a request to compare its recorded assessment and draft decision. Results paginate in groups of 20; older previews may need rerunning to populate details. Editing a tested draft stops its outdated live simulation and invalidates the old preview.

## Implementation

`backend/policy_actions.py` normalizes action facts; `backend/policies.py` handles matching and draft lifecycle. Matching is shared by previews and enforcement. Snapshots preserve assessed policy versions; revision checks reject stale edits. Legacy versions retain their original matcher. Migrations 0013–0014 add persistent drafts/previews and paused-policy retention.

Debug mode overrides custom routing and judging on new assessments, while built-in prohibitions, incomplete-action checks, and deadlines remain enforced. Turn Debug off to resume configured rules.

Policies and audit history live in local SQLite. Code running under the same OS account can bypass these controls. For verification, see [testing](testing.md); for the design history, see [RFC 006](rfc-006-safety-performance.md).
