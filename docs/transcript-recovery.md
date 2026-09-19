# Automatic transcript replay

Implemented 18 September 2026; supersedes the earlier verification-and-warning behavior.

Provider transcripts are working files. Relay automatically replays a file when its header changes, it becomes shorter than the saved offset, the consumed tail changes, or the saved position no longer ends on a record boundary. Temporarily empty/incomplete files wait for complete records. No connection recreation, manual checkpoint repair, or rewrite warning is shown. Replay diagnostics use DEBUG logging only. Genuine malformed JSON and filesystem access failures still report errors.

## Identity and retained history

Codex events use a hash of record type, original timestamp and full payload, plus an occurrence number. Extra envelope fields such as ordinals and metadata do not change identity. Identical repeated records retain their multiplicity. Per-file occurrence counters are saved with the byte checkpoint so bounded 5,000-record batches and restarts resume correctly. Existing byte-based identities migrate lazily, preserving event primary keys, hooks and safety evaluations.

On rewrite, the cursor and counters reset and records replay through the same deduplication path. Previously imported history remains even when removed or reordered in the source. Changed Codex contents are retained as new observations rather than deleting the prior version. Metrics describe retained observed history, not an exact mirror of the latest compacted file. Changed contents/timestamps can count as another observation; this is not a semantic merge of revisions. Indistinguishable duplicates without stable provider identities cannot be assigned cross-rewrite provenance beyond occurrence counts.

Claude keeps its existing UUID/block identities or hash fallback and now also replays automatically. A different session identity in a replaced path imports separately. Source classification continues separating Desktop and CLI. Source files are never modified.

The tail checksum covers the last 4 KiB consumed. Header, size, boundary and tail checks detect typical rewrites without rehashing entire transcripts on every poll. They do not guarantee detection of arbitrary same-size middle-of-file edits with unchanged header and tail. The occurrence dictionary grows with unique records per file; this remains a local SQLite implementation.

## Operation and verification

Migration 0006 adds occurrence counters and tail checksums. The first upgraded scan lazily migrates old IDs and replays existing Codex sources in bounded batches. Ingestion and checkpoints commit together; failures roll back. Normal connection status is watching, and stale rewrite warnings clear after successful collection. Developers can enable DEBUG logging for backend.connectors and backend.claude_code to inspect replay events.

Tests cover truncation, reorder, edited/replaced files, retained history and audit links, legacy migration, bounded-batch restart, identical repeated records, subsequent appends, tail changes, rollback, source isolation and Claude replay. Rollout is preceded by a database backup and a dry run against a separate database copy.
