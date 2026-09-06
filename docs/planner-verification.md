# Planner AI verification — 2026-09-07

This record separates checks that were executed from acceptance work that requires real accounts. Implementation details and tool contracts are in [Planner AI](planner-ai.md).

## Reproducible checks

| Boundary | Command | Recorded result |
| --- | --- | --- |
| Planner, document preservation, AI bridge and tab restoration | `pnpm --filter @kuku/desktop exec vitest run src/plugins/builtin/planner src/lib/__tests__/planner_tasks.test.ts src/plugins/document_events.test.ts src/plugins/document_mutations.test.ts src/plugins/document_sessions.test.ts src/plugins/builtin/core_editor/__tests__/task_identity.test.ts src/plugins/builtin/core_editor/__tests__/list_input_rule.test.ts src/plugins/builtin/ai_chat/proxy_tool_bridge.test.ts src/stores/__tests__/files_open_tab_state.test.ts` | Passed |
| Complete desktop frontend suite | `pnpm --filter @kuku/desktop exec vitest run` | Passed |
| Application TypeScript | `pnpm --filter @kuku/desktop exec tsc --noEmit -p tsconfig.app.json` | Passed |
| Native AI access and session behavior | `cargo test -p kuku-ai --lib` | Passed |
| Gemini schema compatibility, credential redaction and native live-model setup | `cargo test -p kuku-ai --features native-smoke --lib` | Passed |
| Configured Gemini model choosing Planner tools and saving through native IPC | `node scripts/planner/native_smoke.mjs --live-model-only` | Passed |
| Rust Planner backend | `cargo test -p kuku-app planner:: --lib` | Passed |
| EventKit serialization and write contracts | `bash scripts/planner/test_native.sh` | Passed with native test doubles |
| Native UI plus deterministic AI execution | `node scripts/planner/native_smoke.mjs --ai` | Passed |

The native runner creates a temporary app-data root, vault, logs, screenshots and JSON result files for each run, then prints their location. A run that needs to preserve artifacts for inspection can be followed by copying that reported directory before the operating system clears temporary files. The `--skip-build` option may reuse the dedicated smoke binary after an initial successful build; it still rebuilds the frontend fixture.

The ordinary KukuDev bundle was also built without the `native-smoke` feature. Its executable was checked for the test-only command names and embedded WebDriver marker; neither was present.

## Native scenarios

The production UI ran in WKWebView with real Tauri file commands and a temporary vault. The run covered source and filter menus, search and sort restoration, date entry, a 450 px pane, 30-minute click creation, 60-minute range creation, lift and settle animation sizes, Escape without writes, dragging, resizing, exact-time undo, completion with retained history, overlap suggestions without premature writes and reload restoration.

The native AI runtime registered all 17 Planner descriptors with their access levels. Ask and Inline mutation calls were rejected without file changes. Agent calls created a task, replayed the same creation without duplication, changed its title and work time, preserved its independent deadline, rejected a stale revision, completed it while preserving the block, restored the creation receipt after reload, unassigned it and deleted it while retaining unrelated note content. The availability call returned the expected 30-minute overlap.

The `--ai` harness supplies deterministic model tool-call input. The mode gate, proxy broker, Tauri events, frontend registry, Planner service and vault persistence remain production code. The separate live-model command uses the normal `ai_new_session` and `ai_send_message` APIs with natural-language prompts. It opts in explicitly to an existing KukuDev Gemini credential; the credential remains in native memory and is not written to result files.

The successful live-model run used the configured `gemini-3.8-flash` model. It made six Planner calls without tool errors: Ask selected task search; Agent selected calendar discovery, task search, task creation and local scheduling; a follow-up selected completion. The isolated Inbox ended with exactly one completed task scheduled for the requested 13:00–14:00 Asia/Seoul slot and no deadline. The original note remained byte-for-byte unchanged, Ask did not create the Inbox, and the calendar retained the completed block as history. The result JSON recorded the public model identifier, model text, tool events and assertions without the credential. The process reset its in-memory AI state and cleaned up normally.

The live-model path also exercised a Keychain authorization wait. Native Keychain reads run off the command executor, AI and auth initialization can be disposed while pending, and the application continues restoring local plugins. Transport errors redact raw and URL-encoded API keys while preserving model and provider diagnostics.

Pointer and keyboard assertions use the embedded driver's events in a real WebView. They verify the application gesture state machine but do not replace a manual check with a physical trackpad.

## Synthetic provider scenarios

The browser fixture's AI console invoked the production registry and handlers against synthetic Google and Apple IPC. It created a multi-day all-day event, replayed creation after reload without duplication, created a linked note, changed the event to a timed event with a location, rejected an old revision and deleted the event while retaining the linked Markdown/YAML note. A synthetic Apple reminder was created, assigned a Google calendar block and completed; its deadline and block remained intact.

Focused tests also cover unavailable and read-only sources, fresh remote versions, page and range failures, stable and duplicate IDs, receipt corruption and interrupted outcomes, disabling during a query, queued creation across a vault change, a changed default calendar during a write, local completion while the calendar is offline, and document changes before or during deletion. These checks do not write to real accounts.

## Deferred external acceptance

Real Google and Apple round trips are deferred until test accounts are attached. Completing external acceptance requires:

1. Configure a Google Desktop OAuth client and designate disposable test calendars.
2. Grant Calendar and Reminders access on a test Mac and designate a disposable reminder list.
3. Verify create, update, delete, retry and provider-side edits in both original apps.
4. Verify consent denial, permission revocation, reconnect cancellation and account-server synchronization.
5. Check week navigation with a physical trackpad, including narrow layouts and horizontal page boundaries.

Local notes, local task scheduling and AI Planner tools remain available without either external account.
