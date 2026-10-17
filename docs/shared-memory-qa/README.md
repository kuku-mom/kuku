# Shared memory release verification — 2026-10-17

These checks used synthetic memories in a disposable PostgreSQL database and
vault. No personal notes, vault contents, or conversation exports were uploaded.
The remote service was the real Go server with its normal email OTP login,
OAuth endpoints and MCP SDK, exposed through a temporary HTTPS tunnel. It was
not the test-only browser fixture or an unauthenticated mock.

## Observed results

| Scenario | Result | Evidence |
| --- | --- | --- |
| ChatGPT DCR, PKCE, Kuku login and consent | Passed | Actual signed-in Chrome account; only `release-qa` was granted |
| ChatGPT search and read | Passed | Retrieved the synthetic teal preference with the context/search/read tools |
| ChatGPT correction | Passed | Same memory ID, `expected_version=1`, committed purple preference at v2; independently confirmed through the authenticated API |
| New ChatGPT conversation | Passed | Fresh search/read returned purple and v2 after the desktop app was quit; [screenshot](chatgpt-new-session.png) |
| Remote grant revocation | Passed | Revoked tokens immediately returned HTTP 401; the next actual ChatGPT tool attempt required reconnecting; [screenshot](chatgpt-revoked.png) |
| Native settings and first save | Passed | Enabled Second Brain in Plugins, opened its settings, configured personal scope and saved a pnpm decision |
| Actual Codex session | Passed | Installed through the app; authenticated `codex exec` called `memory_context` and `memory_read`; [tool receipts](codex-recall.json), [verified connection](desktop-connected.png) |
| Undo and restore | Passed | Undo removed the memory from actual MCP search; undoing that change restored the same ID and body at v3 |
| Local revoke and configuration preservation | Passed | Old connector received `Connection revoked`; all other parsed Codex settings remained equal |
| App auto-start | Passed | Quit the app, then started the bundled connector with only macOS system directories in PATH; it launched Kuku through LaunchServices and read the v3 memory |
| Bundle contents and architecture | Passed | Executable mode 0755; app and connector arm64; connector linked only libSystem, libiconv and CoreFoundation |
| Local signature sealing | Passed, ad-hoc only | Sealed the QA bundle and connector locally; `codesign --verify --deep --strict` passed. This is not Developer ID or notarization validation |
| MCPB | Passed | Native release connector packed; extracted manifest passed the official MCPB schema validator |
| Claude web | Blocked by account capacity | Signed-in Free account already had a custom connector and Add custom connector was disabled. Its existing connection was preserved |

The temporary tunnel still ran on the test Mac. **Mac powered-off availability
has not been verified.** Quitting the desktop app is a separate, narrower check.

## Problems found and corrected

- The memory settings component was declared in plugin metadata but had no
  `settingsSection` view, so it was absent from the native navigation. Registered
  the view and loaded its persisted panel settings without assuming host props;
  the actual bundled UI was then exercised successfully.
- Email sign-in lost the MCP authorization return URL and sent the user to the
  dashboard. The sign-in link now carries the validated local redirect path.
  Repeated normal OTP sign-in returned to the original OAuth consent page.
- The temporary loopback proxy forwarded its public hostname to the SDK's
  localhost-only listener, which the SDK correctly rejected. Fixed the QA
  proxy's upstream Host; retained the SDK's rebinding and origin protections.
- Completed explicit tool annotations, including a destructive update hint for
  correction-capable `memory_remember`. A narrow SDK response adapter preserves
  explicit `readOnlyHint: false`; [observed wire descriptors](tool-annotations.json).

## Automated checks

- Rust: 410 desktop tests, 9 memory-core tests and the two-process stdio MCP test.
- Clippy: desktop, memory and MCP crates, all targets, warnings denied.
- Go: `go test -race ./...`, with actual PostgreSQL memory integration tests,
  including the new raw-wire annotation regression test.
- Desktop: type checking, focused lint, production frontend build and all
  45 existing Knowledge tests.
- Web: production build and Astro check, 0 errors/warnings/hints.
- Existing unrelated Planner timezone failure remains documented in
  [the memory guide](../shared-memory.md).

## Maintainer release gates

1. Deploy migration 00008, API and web consent page to a persistent staging host.
   Configure the public HTTPS issuer, CORS and the two memory feature flags.
2. Repeat ChatGPT and Claude read/write/correction/revocation checks on that
   deployment, including approval behavior after refreshing tool descriptors.
   Claude needs an available custom-connector slot or a supported account.
3. Stop the originating desktop Mac and verify both web clients still read the
   persistent host. Test cross-client correction and offline sync there.
4. Build with the existing release updater key and **Developer ID Application**
   identity. Notarize, staple and verify the distributable; install on a clean Mac
   and test the Claude Desktop MCPB in the actual host. No Apple Development
   identity was substituted for a distribution identity.
5. Complete provider review only if publishing to a public directory. The
   private ChatGPT QA connector is not a public listing or approval.

Test grants were revoked after verification. The private ChatGPT QA plugin was
uninstalled using its recoverable Remove action; its unpublished definition was
not permanently deleted. [Cleanup evidence](chatgpt-cleanup.png).
The disposable tunnel/database are not a deployment target or a usable
production connection.
