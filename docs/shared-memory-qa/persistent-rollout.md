# Persistent rollout status — 2026-10-18

## Verified

- Packaged native macOS application with embedded frontend and native MCP executable; no Vite, Python, Node or temporary directory required at runtime. This is a local debug preview bundle, not a signed/notarized release.
- Desktop synchronization code exercised against a real Go HTTP server and isolated PostgreSQL using a synthetic account: first replica publication, second replica download, conflicting offline corrections, explicit conflict resolution, deletion propagation and repeated synchronization without resurrection.
- Timer/manual/tool-triggered synchronization now shares a mutex to prevent overlapping cursor/outbox processing.
- Core Rust tests (12), native two-client stdio integration (1), desktop memory tests (3), and Go memory race tests passed.

The server integration can be repeated with:

```sh
KUKU_MEMORY_SYNC_TEST_URL=http://127.0.0.1:58089 \
KUKU_MEMORY_SYNC_TEST_TOKEN_FILE=/private/path/to/synthetic-account-token \
cargo test -p kuku-app real_server_roundtrip_offline_conflict_and_delete -- --ignored
```

Use an isolated server/database and synthetic account. The test creates a uniquely named scope and tombstoned synthetic memory. It never reads a production credential. This tests the synchronization engine directly; it does not claim validation of desktop login, the 30-second scheduler, or production background synchronization.

## Persistent local installation

- Installed `KukuPreview.app` in the user's Applications directory, with the selected existing vault and a new `ai-shared` scope. Existing notes were not imported and cloud sharing remains disabled until deployment.
- Registered user-level `kuku` MCP entries and memory skills for Cursor and Grok Build, preserving unrelated configuration. Removed the owned `kuku-client-qa` Grok entry.
- Grok Build MCP doctor discovered five tools. An actual Grok Build session called context, committed checkpoint `mem_b9226ca9b7514c2990038c5aaab1369e` version 1, and read it back from the installed app. Session: `01a150fa-22d1-7af0-abaa-c0f64e8d1ff3`.
- After stopping the installed app, the native recall hook automatically relaunched Kuku and returned the saved checkpoint without a frontend dev server.
- A fresh Cursor agent discovered the user-level `kuku` connection, read the Grok Build checkpoint ID/version/state, and committed receipt `mem_915fc259bc8e4b9492909af4f625a23e`. Both clients now have actual read/write activity on the persistent local installation. Cursor chat: `f5c6be77-3375-4849-8b29-383b5cc189cc`. The initial receipt text lost Korean characters during native typing. Reusing its request ID with different content was correctly rejected; Cursor then read the current version and committed a new-request CAS correction to version 2. Independently verified the final body and `shared: false`.
- Fixed settings initialization when the only configured scope is not `personal`; previously the select displayed the available scope while actions remained bound to an absent scope.

## Release blockers

- The production discovery URL `https://api.kuku.mom/.well-known/oauth-authorization-server` returned HTTP 401 with the legacy unauthenticated response. Public MCP OAuth discovery is not yet usable there.
- This checkout has deployment templates but no production environment file, SSH destination, or configured deployment credentials. The production Compose image is still a placeholder. Do not repoint users' remote connectors to it yet.
- The previous `trycloudflare.com` connection is temporary and hosted on the same Mac. It cannot satisfy Mac-off operation. Grok Bot, ChatGPT and Claude need reconnection to the deployed stable endpoint.
- Actual desktop-account automatic synchronization, remote-host independence/Mac-off, and full five-client handoff remain pending. Prior client-specific evidence is in `client-handoff.json`.
- Apple signing/notarization and release updater signing remain maintainer-owned. The locally installed preview is not a release artifact.
- Hy-Memory A/B quality evaluation remains blocked on embedding model access; native engine adoption is provisional, not a verified SDK replacement.

## Maintainer deployment handoff

1. Deploy the PR's Go server to the existing always-on host, with database migrations through `00009_memory_verification.sql` and a persistent PostgreSQL database/backup policy.
2. Set `MEMORY_FEATURE_ENABLED=true`, `MEMORY_WRITES_ENABLED=true`, `MEMORY_ISSUER=https://api.kuku.mom`, and the existing production authentication/email configuration. Keep secrets out of Git.
3. Deploy the web OAuth consent page with `PUBLIC_KUKU_API_BASE_URL=https://api.kuku.mom`. Ensure the public discovery and OAuth routes are not intercepted by account-session middleware or a browser-only access challenge.
4. Verify public discovery, PKCE authorization and scoped grants; connect the desktop account and explicitly enable only the intended shared scope. Run real timer-driven desktop↔web round trips and offline conflict/revocation tests.
5. Stop the Mac's app, API and tunnel, then exercise remote read/checkpoint from a separate machine. Perform physical Mac-off verification separately; record actual evidence rather than inferring it from a tunnel test.
6. Reconnect Grok Bot/ChatGPT/Claude to `https://api.kuku.mom/mcp`, verify each new session and revocation, then build signed/notarized desktop and MCPB releases. Keep PR/release validation pending until these checks pass.
