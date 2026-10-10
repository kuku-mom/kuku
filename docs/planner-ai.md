# Planner in AI Chat

Planner registers its tools with the shared `core-tool-registry` after its service activates. AI Chat forwards their schemas and access levels to the native AI runtime. Disabling Planner removes the handlers and native descriptors; local notes and saved links remain intact. Planner works without AI Chat enabled.

## What the assistant can do

| Tools | Behavior |
| --- | --- |
| `planner_tasks_search`, `planner_task_read` | Read current note tasks and Apple reminders, search and sort, and return item references with revisions. |
| `planner_calendars_list`, `planner_events_list`, `planner_event_read` | Discover connected calendars and their capabilities; read a requested range or the latest individual event. |
| `planner_availability` | Find free slots and report overlaps without scheduling anything. |
| `planner_task_create`, `planner_task_update`, `planner_task_complete` | Save a task or edit its source title, dates and completion. |
| `planner_task_schedule`, `planner_task_unassign` | Assign or move the task's single block, or remove that block while keeping the task. |
| `planner_task_delete` | Delete the source task with an explicit choice about its linked block. |
| `planner_event_create`, `planner_event_update`, `planner_event_delete` | Change writable calendar events through the same guarded service as the Planner UI. |
| `planner_open_source`, `planner_link_note` | Open the original item or attach an existing/new note to an external item. |

Ask and Inline modes only receive read-only tools. Agent mode can also use mutation tools, which save immediately through Planner's normal document/provider path when the user requests the action. These tools do not open the generic file-edit approval dialog. Their descriptions and the model prompt state this behavior. Chat progress and settings labels are translated into Korean, English and Japanese.

Tools do not connect accounts, change permissions or default calendars, edit recurrence rules, manage invitations, or publish existing local blocks in bulk. Those controls stay in Planner settings and the original calendar service. A completed task keeps its time block as history. A task's deadline remains independent of its scheduled work time.

## Identity, conflicts and retries

Use the reference and revision returned by a search/read operation. References are opaque and belong to the current vault and plugin activation. Tools do not find mutation targets by title. Fresh source reads and the service's expected snapshots/ETags guard edits; duplicate IDs, stale versions, unavailable sources and read-only items return errors.

Read-only task scans refresh the index from the current document owner, including unsaved editor state, without queuing remote synchronization. A failed or superseded scan rejects the query instead of reporting a partial index as complete. Calendar range reads do not navigate the visible Planner tab. The tool results supply the current date and time zone for relative-date requests.

Creation requests require a stable `request_id`. Repeating the same request within an activation shares its pending promise. The plugin also writes a device-local, vault-bound receipt before creating anything and saves the created item's locator afterward. A completed receipt can resolve the existing result after restart. A started receipt without a confirmed result returns an unknown outcome and prevents automatic recreation. Review the item's state and Planner's durable pending operations before proceeding; do not hide an uncertain result by inventing a new request ID. Receipts are separate from the Markdown-synchronized note data.

The native AI runtime rechecks tool identity, schema and access against the descriptors that were offered to the model. The proxy call also carries the approved access level; the frontend rejects a removed, disabled, replaced or differently classified handler. Pending bridge registrations are cleaned up when plugins unload.

The Gemini adapter preserves nullable references and date-clearing fields when converting the shared JSON Schema into the provider's schema. Parameterless tools omit their parameter object. Provider errors redact API credentials, including credentials in request URLs, while retaining status and model diagnostics.

## Verification scope

Unit and integration tests cover argument validation, references, conflicts, request receipts, mode access and bridge lifecycle. The browser-only Planner fixture includes an **AI tools** console that invokes the production registry and handlers against synthetic provider IPC.

The [native smoke harness](planner-native-smoke.md) uses a separate app, temporary vault and an explicit debug-only feature. Its `--ai` deterministic call input enters the production native mode gate and proxy broker, crosses the real Tauri event bridge, runs the production Planner handler, and saves through native vault commands. This mode verifies execution, not model selection. The separate `--live-model` and `--live-model-only` opt-ins reuse the configured KukuDev Gemini connection to submit natural-language requests through the normal AI session API and assert the model's tool choices and saved Markdown. The Keychain credential remains in the native backend and is neither copied to test files nor returned in configuration. All test entry points are absent from ordinary Kuku and KukuDev builds.

Live Google OAuth, EventKit account synchronization and live model selection require configured test accounts. Synthetic provider responses, native EventKit test doubles and deterministic AI input are not evidence of those external integrations.
