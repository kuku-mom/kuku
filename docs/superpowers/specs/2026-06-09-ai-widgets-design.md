# AI Widgets Design

## Goal

Bring Obsidian Steward's widget and visualization idea into Kuku without porting the Obsidian plugin directly. Kuku will first support AI-created visual artifacts in chat, then persist those artifacts as reusable widget projects in Kuku's plugin data sandbox. CLI agent integration is explicitly out of scope for this phase.

## Source Reference

Steward's README describes widgets and visualizations as AI-generated artifacts inside an Obsidian agent workflow, alongside tools, guardrails, MCP, BYOK-style model flexibility, and chat UI. Steward is MIT licensed, so ideas can be reused and code can be copied only if the license notice is preserved. This design does not copy Steward code because Steward is tightly coupled to Obsidian APIs and Kuku already has its own Tauri AI runtime and proxy tool registry.

Sources:
- https://github.com/googlicius/obsidian-steward
- https://github.com/googlicius/obsidian-steward/blob/main/LICENSE

## Scope

In scope:
- An AI proxy tool named `create_widget` that accepts HTML or SVG widget content.
- AI proxy tools named `list_widgets` and `read_widget` so the assistant can reuse stored widget projects in later turns.
- A typed widget artifact envelope in tool output.
- A chat renderer that detects widget artifact output and displays it in a sandboxed iframe.
- Persistent widget projects under the `ai-widgets` plugin sandbox, not in the user's vault.
- Tests for artifact parsing, argument normalization, safe project paths, persistence, and iframe security defaults.

Out of scope:
- CLI agent provider or terminal-side build agent.
- Direct vault writes for widget projects.
- Network-enabled widgets.
- Direct Tauri API access from widget code.
- A full widget gallery settings page.

## Architecture

Kuku already has a Rust AI runtime and a frontend proxy tool bridge. The widget feature should use that existing bridge instead of adding a new backend AI path.

The `ai-widgets` plugin will depend on `core-tool-registry`. On activation it registers three proxy tools:
- `create_widget`: create or update a widget project and return a renderable artifact.
- `list_widgets`: list saved widget project summaries.
- `read_widget`: read a saved widget project's manifest and files.

The tool handler writes to `~/.kuku/plugins/ai-widgets/projects/{widgetId}` through existing `plugin_fs_*` Tauri commands. The frontend never exposes arbitrary filesystem paths to the model.

## Data Model

A widget project contains:
- `manifest.json`: id, name, type, entry file, created/updated timestamps.
- `files/*`: declared project files.

A chat artifact output is JSON with this shape:

```json
{
  "kind": "kuku.widget-artifact",
  "version": 1,
  "widget": {
    "id": "daily-trends",
    "name": "Daily Trends",
    "type": "html",
    "entry": "index.html",
    "files": [
      { "path": "index.html", "content": "<div>...</div>" }
    ]
  },
  "projectPath": "projects/daily-trends"
}
```

## Security

Widgets are untrusted because an AI or user can generate their code. The renderer must:
- Use an iframe.
- Set `sandbox="allow-scripts"` and omit `allow-same-origin`.
- Build `srcdoc` with a restrictive CSP: no default resources, inline scripts/styles only, data/blob images, no network connections, no forms, no base URL.
- Avoid exposing Tauri APIs, app stores, or vault mutation functions to the iframe.
- Only accept project-relative file paths that are normal path segments without `..`, absolute paths, backslashes, query strings, or fragments.

This is intentionally stricter than many demo artifact renderers. The cost is that network-backed visualizations will not work yet; the benefit is that a generated widget cannot silently become a desktop app escape hatch.

## UX

When the assistant calls `create_widget`, the tool progress area shows the usual compact tool line plus an embedded widget preview. The preview includes a small header with the widget name and saved project id. If rendering fails, it falls back to a compact error block rather than breaking the chat thread.

## Testing

Frontend unit tests will cover:
- Tool argument normalization rejects missing content, unsafe paths, invalid widget types, and oversized names.
- Widget artifact output parses only the explicit `kuku.widget-artifact` envelope.
- The project store writes manifest and files under the expected plugin sandbox paths.
- The iframe document includes restrictive CSP and does not use `allow-same-origin`.
- Chat tool rendering recognizes successful widget tool outputs.

Manual verification:
- Run `pnpm --filter @kuku/desktop build`.
- Run `cargo check -p kuku-app`.
- Start the Tauri dev app and confirm the AI chat settings/tools list includes widget tools.
- Use the desktop app UI to verify the app still renders after the widget plugin is activated.
