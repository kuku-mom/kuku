import { renderToString } from "solid-js/web";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MarkdownMessage as MarkdownMessageType } from "./markdown_message";

import { editorCoreMarkdown } from "~/plugins/builtin/core_editor/markdown_handlers";
import { wikilinkMarkdown } from "~/plugins/builtin/wikilink/markdown_handlers";
import { buildMarkdownService, contributeMarkdown } from "~/plugins/markdown_service";

vi.mock("~/components/scroll_area", () => ({
  default: (props: { children: unknown }) => props.children,
}));

let renderMessage: typeof MarkdownMessageType;

beforeAll(() => {
  contributeMarkdown("core-editor", editorCoreMarkdown);
  contributeMarkdown("wikilink", wikilinkMarkdown);
  buildMarkdownService();
});

beforeAll(async () => {
  ({ MarkdownMessage: renderMessage } = await import("./markdown_message"));
});

describe("MarkdownMessage", () => {
  it("renders task list items with disabled checkboxes", () => {
    const html = renderToString(() => renderMessage({ content: "- [x] shipped\n- [ ] pending" }));

    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
    expect(html).toContain("kuku-markdown-task-list");
    expect(html).toContain("kuku-task-checkbox__control");
    expect(html).toContain("shipped");
    expect(html).toContain("pending");
  });

  it("uses the shared markdown service for wikilinks and directives", () => {
    const html = renderToString(() =>
      renderMessage({ content: "Before\n\n::br\n\nSee [[notes/today|Today note]]" }),
    );

    expect(html).toContain("Before");
    expect(html).toContain("Today note");
    expect(html).toContain('title="notes/today"');
    expect(html).not.toContain("::br");
    expect(html).not.toContain("[[notes/today|Today note]]");
  });
});
