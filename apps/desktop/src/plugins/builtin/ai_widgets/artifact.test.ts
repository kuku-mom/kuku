import { describe, expect, it } from "vitest";

import {
  parseWidgetArtifactOutput,
  serializeWidgetArtifactOutput,
} from "~/plugins/builtin/ai_widgets/artifact";
import type { WidgetArtifactEnvelope } from "~/plugins/builtin/ai_widgets/types";

describe("widget artifact envelope", () => {
  it("round-trips only the explicit kuku widget artifact envelope", () => {
    const envelope: WidgetArtifactEnvelope = {
      kind: "kuku.widget-artifact",
      version: 1,
      projectPath: "projects/daily-trends",
      markdownEmbed: "```kuku-widget\nid: daily-trends\nheight: 320\n```",
      widget: {
        id: "daily-trends",
        name: "Daily Trends",
        type: "html",
        entry: "index.html",
        files: [{ path: "index.html", content: "<h1>Daily Trends</h1>" }],
        createdAt: "2026-06-09T00:00:00.000Z",
        updatedAt: "2026-06-09T00:00:00.000Z",
      },
    };

    const serialized = serializeWidgetArtifactOutput(envelope);
    expect(parseWidgetArtifactOutput(serialized)).toEqual(envelope);
  });

  it("rejects ordinary JSON so normal tool output is not treated as a widget", () => {
    expect(parseWidgetArtifactOutput(JSON.stringify({ ok: true }))).toBeNull();
    expect(parseWidgetArtifactOutput("not-json")).toBeNull();
    expect(
      parseWidgetArtifactOutput(JSON.stringify({ kind: "kuku.widget-artifact", version: 2 })),
    ).toBeNull();
  });
});
