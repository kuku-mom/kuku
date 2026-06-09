import { describe, expect, it } from "vitest";

import { mdastToProseMirror, proseMirrorToMdast } from "~/lib/markdown";
import { createProcessor } from "~/lib/markdown";
import { RegistryBuilder } from "~/lib/markdown/registry";
import { editorCoreMarkdown } from "~/plugins/builtin/core_editor/markdown_handlers";

import { aiWidgetsPlugin } from "./index";

describe("AI widget markdown", () => {
  it("round-trips kuku-widget fences as renderable widget nodes", () => {
    const contribution = aiWidgetsPlugin.editor?.markdown;
    expect(contribution).toBeDefined();

    const registry = new RegistryBuilder()
      .addBase()
      .addMdastBlockHandler("code", editorCoreMarkdown.mdastToPm?.block?.code!)
      .addPmBlockHandler("codeBlock", editorCoreMarkdown.pmToMdast?.block?.codeBlock!)
      .addMdastBlockHandler("code", contribution!.mdastToPm?.block?.code!)
      .addPmBlockHandler("kukuWidget", contribution!.pmToMdast?.block?.kukuWidget!)
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
