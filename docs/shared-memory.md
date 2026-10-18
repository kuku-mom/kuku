# Shared AI memory

Kuku exposes the same scoped memory operations to its AI chat, local MCP clients,
and authenticated remote MCP clients. Local-only memories remain in the vault.
Searchable cloud sharing is a separate, explicit publication of memory text and
approved source excerpts; it does not decrypt or publish encrypted sync objects.

## Start locally

1. Open a vault. If Second Brain is disabled, enable it in **Settings → Plugins**
   and restart. Open **Settings → Second Brain → Memory for your AI**.
2. Add `personal` or a project scope. Enable local connections and local writes.
3. Choose automatic saving per scope. Otherwise writes create existing Kuku
   decision documents for review. A conflicting exact title also needs review
   unless the caller supplies the target ID and expected version.
4. Connect Codex, Claude Code, or Claude Desktop to selected scopes. Restart the
   client and ask it to search Kuku memory. Installation is not shown as verified
   until a real tool call succeeds.

The connector is a native `kuku-mcp` executable. End users do not need Node,
Python, Docker, Homebrew SQLite, an embedding model, or a separate API key.
Codex and Claude Code receive a dedicated memory skill. Claude Code also gets a
SessionStart recall hook. Other hooks are not assumed. Desktop extensions can
use the included `.mcpb` with pairing values shown after connection.

Disconnecting revokes the grant first and removes only the configuration, skill,
and hook owned by that connection. Existing entries from other integrations and
Codex TOML comments are preserved. A conflicting `kuku` entry is never overwritten.

## Enable web AI

Apply server migration `00008_memory.sql` using the existing migration runner.
Configure the existing Go server with:

```dotenv
MEMORY_FEATURE_ENABLED=true
MEMORY_WRITES_ENABLED=true
MEMORY_ISSUER=https://api.example.com
CLIENT_WEB_URL=https://app.example.com
```

The issuer must be the public HTTPS API origin in production. Keep both feature
flags false until deploying and validating the new server. Setting the write
flag false pauses remote additions/corrections while queries remain available;
authenticated deletion and sharing revocation can still be published.

In Kuku, select **Share** on individual memories, or enable sharing of new
memories in a scope. **Allow account access and sync** uses the existing Kuku
login and enables background synchronization for that vault. Background sync
runs every 30 seconds; writes also try to sync immediately with a bounded wait.
Unsent changes remain visible in the queue. Turning off background sync leaves
the last published version available; use **Stop sharing** to remove access.
Stopping sharing remains effective on later edits, even in an automatically
shared scope. Re-sharing is an explicit action.

Add `https://api.example.com/mcp` as a custom OAuth MCP connection in ChatGPT or
Claude. The `/memory/connect` page shows the requesting app, lets the user choose
scopes and write access, and lists grants with verification/revocation controls.
Clients use authorization-code + S256 PKCE, registered exact redirect URIs,
resource-bound grants, one-use codes, and rotating refresh tokens. Tokens are
stored hashed, and every MCP request checks expiry and revocation.

Web AI uses the published database while the Mac is off. Source document paths
and source origins are removed from cloud publications; source notes and whole
conversations are not uploaded. The connected AI provider receives the memories
returned to its conversation. Custom connector support and write confirmations
depend on the host account and product.

## Interfaces and behavior

| MCP tool | Input | Result |
| --- | --- | --- |
| `memory_context` | query, optional scope/limit | At most five brief records |
| `memory_search` | query, optional scope/limit | Scoped, active, unexpired summaries |
| `memory_read` | id | Full authorized active memory and sources |
| `memory_remember` | request_id, scope, title, body; optional id + expected_version, kind, tags, source_refs, expires_at | committed, proposed, or conflict; ID and version |

Repeat the same request ID only with identical input. Corrections require the
current version. Omitted/null optional metadata preserves the current kind,
tags, source evidence and expiry; explicit empty arrays clear tags or sources.
An exact duplicate reuses the existing memory. Unidentified
semantic contradictions remain the client's responsibility: instructions require
searching and reading relevant memories before saving a decision. V1 uses lexical
search and bilingual/synonym retries, not an embedding or semantic inference engine.

Search never returns full source quotes. Read the selected ID when details are
needed. Context is reference data and cannot override current user instructions.

The authenticated desktop API is `POST /api/memory` with `{method, params}`;
publication, change cursors, configuration and grant management are not MCP
tools. The desktop's `memory_admin` command is the management boundary, and
`memory_tool` is the internal AI boundary. External identity, scopes and auto-save
policy come from connection grants; model arguments cannot choose an identity.

Local Markdown uses the existing MemoryItem fields plus optional metadata.
External source URLs are preserved as source origins with compatible relative
reference paths. Deleted memories render as archived Markdown with a tombstone
marker so older readers can still parse them. SQLite contains a rebuildable FTS5
index plus the durable receipts, undo journal and outbox: rebuild the index using
the UI, rather than deleting the journal database.

Shared memories use cloud revisions. Offline edits carry their known cloud base.
A conflict never silently overwrites either side. **Use cloud version** preserves
the previous local content in change history, after which the user can merge it
with an explicit edit. Tombstones reject stale resurrection; an intentional undo
is bound to the deleted revision. Vaults bind sharing to an account so signing in
to another account cannot accidentally publish that vault's memories.

## Build and verify

```sh
python3 scripts/memory/package.py --debug
cargo test -p kuku-memory -p kuku-mcp
cargo run -p kuku-memory --example retrieval_eval
cargo test -p kuku-app
cargo clippy -p kuku-memory -p kuku-mcp -p kuku-app --all-targets -- -D warnings
pnpm --filter @kuku/desktop exec tsc -b
pnpm --filter @kuku/desktop exec vitest run src/plugins/builtin/knowledge
pnpm --filter @kuku/web exec astro check
```

The Tauri build hook builds and bundles the native connector and MCPB. Release
packaging uses `APPLE_SIGNING_IDENTITY` when present and verifies the executable's
signature. The existing application notarization flow remains the distribution
gate. MCPB validation takes the extracted `manifest.json`, not the ZIP itself.

Run server memory integration tests against a disposable PostgreSQL database:

```sh
cd apps/server
KUKU_MEMORY_TEST_DATABASE_URL='postgres://localhost/kuku_memory_test?sslmode=disable' go test -race ./internal/memory
go test -race ./...
```

`browser_fixture_test.go` is an explicitly enabled, test-only authenticated
fixture for browser QA. It is not part of the production binary. The stdio test
starts two real native connector processes against the actual memory store to
verify cross-client recall and scope rejection.

Verified during implementation: native core/MCP tests, existing desktop Rust
tests, PostgreSQL migrations, concurrent CAS, idempotency, source/scope isolation,
OAuth code replay rejection, immediate token revocation, official SDK remote MCP
calls, production frontend builds, actual ChatGPT OAuth/read/write/new-session
and revocation flows, actual Claude OAuth/read/write/new-session and one-time
tool approvals, actual Codex recall, native settings/undo and connector
auto-start. See [release verification evidence](shared-memory-qa/README.md).
An existing Planner TS test depends on the host timezone:
it fails under America/Los_Angeles and passes under Asia/Seoul.

Release checks still required on actual supported accounts/devices:

- Both clients against a persistent deployment, provider write-confirmation
  behavior after refreshing descriptors, and cross-client correction propagation.
- Repeat Claude grant revocation against the persistent host. The actual Free
  account was connected successfully after the user authorized replacing its
  occupied custom-connector slot.
- Mac powered-off availability against the persistent host. The temporary HTTPS
  service used for actual ChatGPT QA ran on the test Mac.
- Signed/notarized application and Desktop extension installation on a clean Mac.
- Provider listing/submission approval if distributing through a public directory.

Those checks are not represented as completed by installation or local SDK tests.

Local tool and cloud-sync observations record only fixed tool names, success,
duration and conflict counts; remote tools use the existing server logger.
No memory text, query, scope, source path or token is included in these events.
The settings screen records connection verification and exposes pending/conflicting
changes. The synthetic bilingual retrieval baseline and its limitations are in
`docs/shared-memory-retrieval.json`; rerun the example to compare future embeddings.

## Project checkpoints and additional clients

The MCP now advertises `memory_checkpoint`. A checkpoint contains `request_id`,
`scope`, `title`, and `record` (`task_id`, `goal`, `state`, `occurred_at`, optional
`decisions`, `open_questions`, `next_actions`, `experiences`). Each experience has
`conditions`, `method`, `result`, and `outcome` (`success`, `failure`, `unverified`).
Corrections require `id` and `expected_version`; sources and expiry are optional.
One checkpoint and all its experiences are one atomic version and undo unit.
Independent records are not silently merged. Read the existing checkpoint before
updating it. An earlier occurrence cannot overwrite a newer observation.

`memory_search` and `memory_context` accept optional `task_id` and `kind` filters.
`memory_context` additionally returns `context.checkpoints` and `omitted_ids`;
`max_chars` bounds selected checkpoint payloads (default 6000, capped at 12000),
not the entire JSON response. `purpose` is accepted for forward compatibility;
current ranking uses query, scope and task, not an LLM interpretation of purpose.
The legacy `memories` result is retained. Each checkpoint includes its ID/version.

Cursor uses `~/.cursor/mcp.json` and `~/.cursor/skills`. Grok Build uses
`$GROK_HOME/config.toml` (default `~/.grok/config.toml`) and its skills directory.
Neither adapter claims verified connectivity until actual tool calls succeed.
Read verification and committed-write verification are tracked separately.
Grok Bot has a remote connection card; real account/OAuth validation remains a
release gate. It cannot access the Mac's Unix socket.

Engine feasibility, actual evidence and unfinished gates are recorded in
[the engine evaluation](shared-memory-engine-decision.md). Hy-Memory is **not**
a product dependency yet.
# Real-client setup notes (2026-10-18)

- Cursor may discover a project MCP configuration but leave it **Disabled**.
  Open **Customize → MCPs → Configure Kuku**, enable that source, and confirm
  the five tools are connected before starting a new agent session. A discovered
  configuration alone is not a successful memory read/write verification.
- Grok Build authentication is separate from the Grok Bot desktop application.
  Run `grok login` and complete its browser OAuth flow. `grok mcp doctor <name>`
  verifies the handshake/tool list, not a model-backed memory operation.
- Grok Build refuses project MCP servers in an untrusted directory. Its current
  doctor message suggests `--trust`, but that flag is not listed in its help.
  Do not disable approval globally to work around this. Kuku's normal user-level
  installation works without changing project trust.
- In the tested Grok Bot build, ask the bot to add the HTTPS MCP endpoint using
  its `AddMcpServer` flow; it displays an authentication card. The OAuth client
  identifies itself as **Cursor**. Authenticate to Kuku and select only the
  intended shared scopes. A local stdio configuration is not a Bot connection.
