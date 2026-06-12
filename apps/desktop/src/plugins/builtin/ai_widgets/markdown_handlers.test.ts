import { describe, expect, it } from "vitest";

import { createProcessor, mdastToProseMirror, proseMirrorToMdast } from "~/lib/markdown";
import { RegistryBuilder } from "~/lib/markdown/registry";
import { editorCoreMarkdown } from "~/plugins/builtin/core_editor/markdown_handlers";

import { aiWidgetsPlugin } from "./index";

describe("AI widget markdown", () => {
  it("round-trips kuku-widget fences as renderable widget nodes", () => {
    const contribution = aiWidgetsPlugin.editor?.markdown;
    expect(contribution).toBeDefined();

    const registry = new RegistryBuilder()
      .addBase()
      .addMdastBlockHandler(
        "code",
        requireHandler(editorCoreMarkdown.mdastToPm?.block?.code, "core code mdast handler"),
      )
      .addPmBlockHandler(
        "codeBlock",
        requireHandler(editorCoreMarkdown.pmToMdast?.block?.codeBlock, "core codeBlock handler"),
      )
      .addMdastBlockHandler(
        "code",
        requireHandler(contribution?.mdastToPm?.block?.code, "widget code mdast handler"),
      )
      .addPmBlockHandler(
        "kukuWidget",
        requireHandler(contribution?.pmToMdast?.block?.kukuWidget, "widget pm handler"),
      )
      .build();
    const processor = createProcessor();

    const pm = mdastToProseMirror(
      processor.parse("```kuku-widget\nid: daily-trends\nheight: 360\n```\n"),
      registry,
    );

    expect(pm.content?.[0]).toEqual({
      type: "kukuWidget",
      attrs: { id: "daily-trends", height: 360 },
    });

    const output = processor.stringify(proseMirrorToMdast(pm, registry));

    expect(output.trim()).toBe("```kuku-widget\nid: daily-trends\nheight: 360\n```");
  });
});

function requireHandler<T>(handler: T | undefined, label: string): T {
  if (!handler) throw new Error(`Missing ${label}`);
  return handler;
}
