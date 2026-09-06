# Google Calendar connection for Planner

Planner connects one Google account and the calendars selected by the user. It can create, edit, move, resize, and delete personal events on writable calendars. Meetings with attendees, protected or special Google events, and entire recurring series stay read-only; a personal recurring occurrence can be edited individually. RSVP and invitation management are not supported. OAuth and API requests run in Rust; access and refresh tokens stay in the existing system keychain store. A Kuku account or backend is not required.

## Configure a development or release build

1. Create a Google Cloud project and enable the Google Calendar API.
2. Configure the OAuth consent screen. Add the two scopes `https://www.googleapis.com/auth/calendar.calendarlist.readonly` and `https://www.googleapis.com/auth/calendar.events`.
3. Create an OAuth client with application type **Desktop app**. Do not use a Web application client.
4. Set `KUKU_GOOGLE_CLIENT_ID` in the environment running the desktop build. Rust embeds this public client ID at compile time. For development, the app process can also read this environment variable at runtime; a runtime value takes precedence.
5. If the downloaded Desktop client credentials include a client secret required by the project, set `KUKU_GOOGLE_CLIENT_SECRET` in the same build/runtime environment. Google treats installed desktop clients as public clients; this value is not a server secret or an API key, and PKCE protects the authorization exchange.
6. In Planner settings, connect Google, approve calendar-list reading and event editing in the system browser, and select calendars. The callback binds an ephemeral port on `127.0.0.1` and expires after three minutes. Closing the browser leaves the connection pending until timeout; disconnecting cancels it.

Connections saved by the original read-only Planner release keep working for reads. To enable editing, reconnect Google in settings. Desktop OAuth does not support incremental authorization: Kuku requests the complete new scope set in a new browser authorization. It replaces stored credentials only after the required grant and offline token are received successfully. Cancelling or declining the new grant leaves the previous read connection intact. Refresh responses that omit scopes preserve the previously known capability; legacy credentials with no recorded scopes remain read-only until reconnecting.

A packaged app launched from Finder does not normally inherit terminal environment variables, so release builds should embed the client configuration. A build with no client ID reports `configured: false` and keeps Google disconnected; local Markdown tasks and Apple connections remain usable.

External OAuth projects in **Testing** issue Calendar refresh tokens that expire after seven days. Configure production publishing and complete the applicable Google verification before distributing a durable public connection. The consent screen and privacy policy should accurately describe calendar reading and personal-event creation, editing, and deletion.

## Data behavior

- Calendar events are fetched as complete, paginated snapshots for the requested visible time range. Recurring events are expanded by Google. A page or calendar failure fails the whole request so the UI can retain the last successful snapshot.
- All-day start/end values stay as calendar dates, with the end date exclusive. Timed values retain RFC3339 offsets and any returned IANA time zone. Original recurrence occurrence values are preserved when an instance moves.
- Calendar capabilities come from `accessRole` and the stored OAuth grant. Shared read-only calendars remain available for viewing. Private redacted events on `writerWithoutPrivateAccess` calendars cannot be edited.
- Each write rechecks calendar access. Updates and deletes use the displayed event's ETag with `If-Match`; a concurrent Google edit produces a conflict instead of an overwrite. Individual occurrence IDs are used for repeated events, while existing encoded display IDs and note links stay compatible.
- Creation uses a deterministic Google-safe event ID derived from the caller's durable operation ID, also stored as a private extended property. An uncertain network response or duplicate-ID response is reconciled by fetching that exact event. Repeating the same operation cannot intentionally create a second event or replace an unrelated event.
- Updates send only the requested editable fields. Attendees, conference links, reminders, recurrence rules, and unrelated Google fields are preserved. No guest invitations or RSVP writes are sent.
- A missing item is reported only after a confirmed not-found, gone, or cancelled response. Temporary network failures remain errors, so refreshing a different week cannot be mistaken for deletion of a linked task block.
- Tokens refresh under a single async lock. Revoked refresh credentials are removed and the UI can request reconnection. Network failures leave stored credentials intact.
- Disconnect cancels an in-progress sign-in and removes local credentials. Users can separately revoke the app's grant from their Google Account permissions page.
- Selecting the same Google calendar through both macOS Calendar and the direct Google connection can show duplicate events. Select one source for that calendar; provider identifiers are intentionally not merged by title or time.
- Release builds use the system keychain. The existing explicit `KUKU_ALLOW_INSECURE_DEBUG_SECURE_STORE` development override also applies to these credentials; it must not be enabled with real account credentials during ordinary testing.

## References

- [Google OAuth for installed desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Calendar authorization scopes](https://developers.google.com/workspace/calendar/api/auth)
- [Events list and pagination](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
- [Conditional writes with ETags](https://developers.google.com/workspace/calendar/api/guides/version-resources)
- [Event creation and custom IDs](https://developers.google.com/workspace/calendar/api/guides/create-events)
- [Editing individual recurring occurrences](https://developers.google.com/workspace/calendar/api/guides/recurringevents)
- [Refresh token expiry](https://developers.google.com/identity/protocols/oauth2#expiration)

## Verification

Rust tests cover legacy read-only grants, partial consent, write capabilities, protected meetings and series, raw event references, stale versions and moved occurrences, optional-field clearing, repeatable operation IDs, all-day end dates, DST offsets, pagination, and OAuth callback validation. These tests use synthetic data and make no account writes. Release verification must still exercise the packaged app with a real OAuth client, a test calendar, permission denial/revocation, and a concurrent edit in Google Calendar.
