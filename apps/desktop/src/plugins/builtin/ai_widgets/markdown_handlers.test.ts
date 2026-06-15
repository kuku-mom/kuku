import { describe, expect, it } from "vitest";

import { createProcessor, mdastToProseMirror, proseMirrorToMdast } from "~/lib/markdown";
import { RegistryBuilder } from "~/lib/markdown/registry";
import { editorCoreMarkdown } from "~/plugins/builtin/core_editor/markdown_handlers";

import { aiWidgetsPlugin } from "./index";

describe("AI widget markdown", () => {
  it("keeps kuku-widget fences as code blocks for preview rendering", () => {
    expect(aiWidgetsPlugin.editor?.markdown).toBeUndefined();

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
      .build();
    const processor = createProcessor();

    const pm = mdastToProseMirror(
      processor.parse("```kuku-widget\nid: daily-trends\nheight: 360\n```\n"),
      registry,
    );

    expect(pm.content?.[0]).toEqual({
      type: "codeBlock",
      attrs: { language: "kuku-widget" },
      content: [{ type: "text", text: "id: daily-trends\nheight: 360" }],
    });

    const output = processor.stringify(proseMirrorToMdast(pm, registry));

    expect(output.trim()).toBe("```kuku-widget\nid: daily-trends\nheight: 360\n```");
  });
});

function requireHandler<T>(handler: T | undefined, label: string): T {
  if (!handler) throw new Error(`Missing ${label}`);
  return handler;
}
