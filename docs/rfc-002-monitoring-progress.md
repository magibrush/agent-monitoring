# RFC 002: Multi-provider monitoring progress

Status: Implemented for manual testing

## Progress since the last push

Relay now monitors Codex Desktop, Codex CLI, and Claude Code through a shared event model. Local discovery, source checks, resumed-session deduplication, and separate subagent histories support the new integrations while retired Claude Desktop imports remain hidden.

Connection setup now starts with an app choice and automatic detection, with custom profiles and folders available under advanced options. Clear provider labels distinguish sources throughout the dashboard. Removing a connection deletes Relay's imported records while preserving the original transcripts.

The dashboard supports conversation composition and per-bar action ranking. Each bar independently assigns ten contrasting colors to its most frequent actions, with overflow grouped in gray. Bounded tooltips and searchable inspection expose exact counts and shares without a global action legend. Search, filters, and Explorer work across providers.

## Validation and boundaries

Backend coverage includes import replay, partial writes, subagents, filtering, and connection removal. Browser coverage includes provider setup, chart interactions, and desktop/mobile overflow with 100 action types. The backend suite, browser workflows, TypeScript checks, and production build passed during implementation.

Source access remains read-only. This release observes recorded activity; it does not enforce or block agent actions. Transcript formats remain provider-dependent.

## Next step

Complete manual testing across all three integrations, then design the separate action-validation and enforcement phase.
