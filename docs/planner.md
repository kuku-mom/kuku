# Planner

Planner is an optional built-in plugin in the **Tauri desktop app**. Open its calendar button in the title bar, command palette, or right panel. Note tasks work without connecting a calendar. Plugin enable/disable follows the existing restart flow.

## Plan your day

- Markdown checkboxes are collected without rewriting notes. Excluded folders are configurable. Capture tasks into `Tasks/Inbox.md` or a writable Apple Reminders list.
- The task list has Today, Upcoming, Unplanned and Completed views and source filters. Overdue note tasks stay visible in Today.
- Search task titles, note paths and Apple reminder-list names together. Space-separated terms all need to match; case and Unicode width differences are ignored. Results follow the selected status/source filters, and their counts update with the search. Due date, allocated time and title sorting mix Kuku and Apple tasks; missing dates go last. Today keeps overdue tasks in their own group. Search and sorting restore with the tab.
- Drag a task into the calendar to allocate 30 minutes. A preview shows its destination. Move it or resize either edge in 15-minute steps; the viewport scrolls while dragging near its edges. A task has one time block.
- Click an empty time or drag a range to create an event. The creation form can switch to a scheduled task. The all-day row creates all-day events. The New event button provides the same form using the keyboard. Escape cancels without creating anything.
- Click the month heading to jump to a date with a Monday-first mini calendar, month navigation, Today or direct date input. Arrow keys move by day/week, Home/End within the week, Page Up/Down by month (Shift by year); Enter selects. The popup fits the Planner pane and returns focus to the heading when closed.
- Creation and time-editing forms offer **Find free time**: up to three nearby, nonoverlapping options between **09:00 and 18:00**, with 15-minute start increments and the current task/event duration. Today's past times are excluded. Picking a suggestion updates the draft; the normal Save action applies it. The form reads the complete chosen date range from displayed calendars and its save destination before offering options, refreshes when opened or the app regains focus, and offers manual refresh. An incomplete/failed calendar read does not offer slots as free.
- Existing overlapping blocks carry an outline warning icon. During a drag/range selection, the calendar footer shows overlapping minutes and titles; the form shows the same information. Minutes count overlapping time once, and an item excludes its own linked block. Completed blocks still occupy time. All-day items appear as context without blocking timed slots. If a linked remote event has moved before the note synchronizes, both ranges remain occupied for other recommendations.
- Due dates remain independent from time blocks. Completion keeps calendar time as history. Removing a block removes the event and unplans the task; it does not delete the source task.
- Click a note task to focus its source checkbox. Existing and new calendar notes use `kuku_planner_links` YAML. Creating a note from an event uses `Calendar/`; viewing an event never creates a note.

## Smaller windows and continuity

- Layout follows the **actual Planner pane width**, after side panels: under 700px shows one day with an expandable task drawer; 700–999px shows tasks beside three days; 1000px and above shows tasks beside the week. Compact capture controls, an icon source filter and allocation labels keep more tasks visible; full note paths remain in tooltips and details.
- Swipe horizontally on the calendar with a trackpad to move **one week** in either direction, including the compact day/three-day views. The calendar follows the gesture, settles back after a short swipe, and slides to the adjacent week after a deliberate swipe. Vertical time scrolling and pinch gestures keep their normal behavior; the live calendar retains its scroll position. One wheel burst, including momentum, can move at most one week. macOS WebView does not expose a reliable momentum phase, so 180ms without input separates bursts. Editing, dragging, resizing or saving a block prevents paging. Navigation buttons keep their day/three-day/week increments. Controls use Kuku outline icons with accessible labels.
- Creation popovers stay inside the Planner pane and beside the selected date columns. When neither side fits, the form reserves space below the calendar and keeps the selected time visible above it. Resizing, scrolling and expanding fields update placement; Escape restores the task drawer and calendar space. The title receives focus once when the form opens.
- The existing tab state restores the selected date, task view, source filter, capture destination, expanded task drawer and calendar scroll position. Resize changes the number of visible days without resetting these choices.
- A current-time line updates every minute and on app return. Without a saved scroll position, today opens near the current time and other dates near 09:00. **Now** returns to today and scrolls to the current time; an existing scroll position takes precedence on reopening. Reduced-motion preferences are respected.
- The right panel shows the selected task/event and preparation notes while Planner is active. In a note, it shows today's tasks and ongoing/upcoming events from a separate current-date seven-day query. Browsing another week does not change this feed. It refreshes on app return, manually, every five minutes and after Apple changes; network failures retain its last successful snapshot, while disconnection or calendar deselection removes the affected data.
- Date/time forms offer **30, 60 and 90 minute** duration presets. Tasks show their allocation time or Unscheduled. The calendar header reports occupied time for the selected date: overlapping intervals and duplicate task/event blocks count once, spans are clipped at local midnight, and all-day events are excluded. Durations use elapsed time across daylight-saving changes.

Saved moves, resizing, completion and supported edits show an **Undo** notice. `⌘Z`/`Ctrl+Z` also works in the active Planner outside text inputs, editors and dialogs, preserving their own undo behavior. History is session-only and clears when the vault changes or Planner is deactivated. Undo checks current task content, bindings and freshly fetched remote content before using the normal guarded write path; subsequent edits, pending writes or an unavailable source stop it instead of overwriting newer work. Restoring a removed linked block creates a new event and is identified in the notice. Deleting a source task is not part of this undo history.

## Calendar connections

Google Calendar and Apple Calendar support event creation, editing and deletion. Apple Reminders supports task creation, title/due-date edits and completion. Editing a repeated event affects **only that occurrence**. Recurrence-rule editing, attendees, invitations, RSVP and special event types remain in the original service. Read-only calendars remain readable.

Choose displayed calendars and a **default calendar** separately. New task allocations publish automatically after choosing a default. Existing local blocks are not bulk-published when connecting. With no default, note tasks can still be scheduled locally.

If the same Google calendar appears via EventKit, use the preferred-connection selector to explicitly pair the calendars and select the connection to use. No title/time matching or automatic cross-provider write fallback occurs.

Google needs a Desktop OAuth client; see [Google setup](planner-google.md). Existing read-only connections stay readable until successfully reconnecting with edit permission. Apple uses EventKit full access and requests permission only when Connect is selected. macOS 10.15 remains supported. Apple save success means saved to the local event store; macOS performs account synchronization afterward.

## Storage and recovery

Checkbox completion, task IDs, dates and time-block link IDs are preserved by the core editor independently of Planner. Copying or splitting a task never inherits its external block link. Safe document mutations use active editors, unsaved inactive tabs and retained meeting documents before conditional disk writes.

`Calendar/Planner Links.md` stores task/event bindings, including provider references, in YAML and uses existing Markdown synchronization. It is created only when needed by a scheduling operation. Credentials and durable operation records stay on the device. If another Mac cannot resolve an Apple calendar identifier, the binding requires review; it is never treated as a deleted event. Disconnecting removes connection/cache state and stops pending remote operations without deleting authored notes or calendar events.

Operations retain pending/failed state. Retrying a create uses the same operation identity and checks whether it already succeeded. Conflict review presents the current event and intended changes before reapplying. A missing result in a weekly query is never treated as a deletion; connected items are checked individually. External note deletion and duplicate task IDs do not trigger destructive calendar writes.

## Verification

Planner is also available through AI Chat's shared tool registry. See [Planner AI tools](planner-ai.md) for supported actions, Ask/Agent access, conflict handling and creation receipts.

The development-only `/tests/planner/index.html` fixture runs the production Planner/editor against synthetic mutable IPC, including provider create/update/delete, offline failures, remote edits, conditional versions and restart persistence. `?reset` resets fixture data only. `?panel=1` adds the contextual right panel and a Note button for checking the Today/detail transition; combine them as `?panel=1&reset`. `window.__plannerFixture` exposes test controls. It never accesses real accounts.

Focused tests cover task search/sorting (`task_query.test.ts`), date navigation and popup placement (`date_navigation.test.ts`), free-time/overlap calculations and linked source identities (`availability.test.ts`, `availability_context.test.ts`), horizontal intent, inertia and pinch/modifier guards (`week_swipe.test.ts`), DOM paging/scroll preservation and cleanup (`week_pager.test.ts`), composer placement within pane boundaries (`composer_placement.test.ts`), initial/current-time scrolling and restoration (`calendar_clock.test.ts`), daily interval merging and DST boundaries (`planning.test.ts`), independent Today queries and late-response/cache handling (`today_feed.test.ts`), and guarded undo including remote changes, note renames/copies and recurring reminders (`undo.test.ts`).

Run frontend verification from `apps/desktop`:

```sh
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json
node node_modules/vitest/vitest.mjs run src/plugins/builtin/planner src/lib/__tests__/planner_tasks.test.ts src/plugins/document_mutations.test.ts src/plugins/document_events.test.ts src/plugins/document_sessions.test.ts src/plugins/builtin/core_editor/__tests__/task_identity.test.ts
```

Run backend verification from the repository root:

```sh
cargo test -p kuku-app planner:: --lib
cargo clippy -p kuku-app --all-targets -- -D warnings
bash scripts/planner/test_native.sh
```

Before release, use a configured Google OAuth client and dedicated test calendars/reminder lists to verify account consent, two-way changes, revocation, recurrence and synchronization in the packaged macOS app. Synthetic fixtures and native serialization/write mocks do not establish real-account integration success.

For actual WKWebView rendering and native local-file persistence checks, see [Native Planner smoke test](planner-native-smoke.md). This harness does not write to live accounts or inject OS mouse events. Apple recurring-event deletion with a lost response can require manual conflict review because EventKit cannot always prove that the exact occurrence is absent. EventKit version checks also cannot make its local save API an atomic conditional write.
