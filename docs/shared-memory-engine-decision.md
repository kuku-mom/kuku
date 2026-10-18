# Shared memory engine evaluation — 2026-10-18

Status: **engine selection pending; do not claim Hy-Memory has been adopted or
rejected on quality grounds.** The existing native engine remains the product
implementation while the independent SDK trial is incomplete.

## Evidence

- Examined upstream commit `7b7fd217a8084fe0d5f9c196d9e4cb88dbba570a`:
  https://github.com/Tencent-Hunyuan/Hy-Memory/tree/7b7fd217a8084fe0d5f9c196d9e4cb88dbba570a
- Upstream LICENSE declares Apache-2.0 without additional restrictions. Kuku is
  MIT. No upstream source was copied into product code in this change. A future
  bundled SDK needs dependency notices and a distribution audit as well.
- PyPI SDK pinned to **2.0.4**. Python 3.12 installation and actual module import
  passed. The isolated environment occupied approximately **681 MiB** (installed
  development environment, NOT compressed application size).
- Python 3.14 selected a source build for Kuzu; that attempt was stopped and
  replaced with Python 3.12 and a binary Kuzu wheel. This does not establish that
  Hy-Memory cannot be bundled.
- OpenAI `gpt-6-luna` access passed actual Responses and Chat Completions calls.
  The same project's `text-embedding-3-small` request returned **403**. The SDK
  initialized on retry, but no valid model-backed add/search quality result is
  available. The provider preflight now detects this failure before the trial;
  empty SDK search results are not counted as successful verification.
  Credentials were passed only in process memory/environment, never saved in
  the repository. Only synthetic evaluation text was sent to OpenAI.
- Reproducible probe: `scripts/memory/hy_memory_probe.py`; result:
  `docs/shared-memory-qa/hy-memory-probe.json`.

## What is implemented from the reference

1. Fact/experience separation: structured task facts and conditional experiences
   in a single atomic checkpoint. Experiences are entries within the checkpoint,
   not independently writable memories. They share its ID/version/undo boundary.
2. Versioned continuation: explicit same-ID CAS corrections and occurrence-time
   checks. Older observations cannot overwrite newer checkpoint state. Separate
   records are deliberately not inferred to be the same task and auto-merged.
3. Rank fusion: bounded lexical candidates plus an exact-tag rank contribution,
   implemented independently in Rust and Go. No embedding model is included.
4. MemHub-inspired durable intake: selected-note snapshots and extraction
   outcomes persist locally. Repeating the same input reopens a completed preview;
   failed/interrupted work can be retried by selecting its source notes again.
   There is no autonomous background retry scheduler in this version.

## Current implementation and limitations

The Rust `MemoryEngine` boundary parses configured-model candidate output,
identifies exact-title candidates for review, and ranks authorized records. It
has no write authority. The Go server accepts structured checkpoints and uses
its existing transactional store and authentication.

`memory_checkpoint` writes one record containing task facts and experiences,
with the existing journal/receipt/outbox path. Markdown stores the optional
`record` field and a readable body. Ordinary body-only corrections must use the
checkpoint tool; manual Markdown body edits invalidate the structured view.
Context is computed from current authorized records, with no derived cache.
Independent conflicting records remain visible with a warning, not an invented
single current state. Semantic reconciliation and graph reasoning are not
implemented.

The shared 40-case fixture exercises bilingual storage contracts, filtering,
reopening, idempotency, and stale-update protection. **It is not 40 natural-language
retrieval questions, an extraction accuracy measurement, or an A/B quality win.**

## Remaining release gates

- Run model-backed A/B evaluation on at least 40 annotated retrieval/extraction
  questions; measure correctness, stale information, latency and model cost.
- Prototype SDK-to-Kuku candidate/ID mapping and SDK-side deletion/isolation;
  audit sidecar packaging before selecting A or B.
- Implement and evaluate semantic consolidation proposals; current conflicts use
  explicit IDs/versions and exact titles only.
- Actual Cursor checkpoint write, Grok Build read/CAS correction, Cursor fresh
  session recall, and Grok Bot OAuth remote read/write passed on 2026-10-18.
  See `shared-memory-qa/client-handoff.json`. The remote fixture was explicitly
  published for QA, so this does not verify desktop-cloud automatic sync.
  Remaining: complete five-client handoff, new-client revocation and Mac-off validation.
- Persistent server deployment, signed/notarized clean-Mac installation, and
  provider distribution requirements. Existing temporary QA hosting is not a
  persistent deployment.

No account setup or production client configuration was changed by the automated
adapter tests. Those tests use temporary home directories.

## Verification executed for this change

- Desktop Rust suite: 411 tests passed; adapter-specific tests rerun after
  ownership-preservation changes.
- Memory core: 12 tests passed, including the shared 40-case contract fixture and
  persistent extraction retry/cache behavior.
- Two actual native MCP subprocesses: checkpoint submission and cross-client
  context recall passed (test hosts, not authenticated vendor applications).
- Go `go test -race ./...`: passed against an isolated PostgreSQL database;
  checkpoint and verification-state tests exercise real SQL/MCP handlers.
- Desktop TypeScript check, focused lint, production build, and 45 Knowledge
  tests passed.
- Native release connector and MCPB package rebuilt. This is not Developer ID
  signing, notarization, or clean-machine install validation.
- New UI has compile/build verification; interactive native UI QA remains pending.

## Real client trial

Cursor initially left the project MCP disabled; enabling it in Customize exposed
all five tools. Cursor wrote checkpoint v1, Grok Build read and corrected it to
v2, and a fresh Cursor session read v2 and its successful experience. Grok Build
needed its separate CLI OAuth login and a user-level MCP registration.

Grok Bot added the remote endpoint through AddMcpServer and completed OAuth
(client name Cursor). Its model read the published checkpoint v2 and committed
a new fact v1. Server grant timestamps independently confirm reads and writes.
Only the synthetic client-qa scope was authorized. The temporary HTTPS service
remains hosted on this Mac; this trial is not evidence of Mac-off availability.
