# Development checkpoint — 16 September 2026

Historical record. For current behavior, see [architecture](architecture.md) and [setup](setup.md).

## Delivered

- Read-only Codex Desktop, Codex CLI, and Claude Code ingestion with checkpoints, replay deduplication, subagent identities, and provider-specific discovery.
- Connection setup, source diagnostics, pause/resume, and deletion of imported records without changing source transcripts.
- Search, conversation Explorer, activity charts, time controls, and provider labels. Later iterations changed chart layout and ranking; see [current usage](usage-reference.md).
- Optional hook observation and transcript correlation, described in [RFC 003](rfc-003-live-hook-observation.md).

## Compatibility findings

Codex CLI 0.154.0 used `originator: "codex-tui"` with `source: "cli"`. The original classifier skipped these files; the corrected parser prefers explicit CLI/exec provenance after Desktop provenance. Two real CLI transcripts imported 46 records without duplicates on replay.

Read-only Claude validation found 40 main sessions, 44 subagents, and 12,686 events, with no new events on replay. Source transcripts were unchanged. Retired Claude Desktop imports remained hidden.

Hook receipt was confirmed locally for Codex CLI and Claude Code. Desktop receipt and broader tool/outcome compatibility remained open at this checkpoint. Enforcement was added in later milestones.

## Recorded verification

The Claude integration checkpoint passed 46 backend and five browser tests plus the production build. The subsequent chart/palette correction passed six browser tests and the build. These are historical checks, not results for the current checkout.

Next milestone: [shadow evaluation](rfc-004-shadow-safety.md).
