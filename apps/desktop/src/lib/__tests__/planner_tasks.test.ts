import { describe, expect, it } from "vitest";
import {
  extractTasks,
  deleteTaskMarkdown,
  parseTaskMetadataComment,
  taskMetadataComment,
  updateTaskMarkdown,
} from "../planner_tasks";
import { editorCoreMarkdown } from "~/plugins/builtin/core_editor/markdown_handlers";
import {
  RegistryBuilder,
  createProcessor,
  mdastToProseMirror,
  proseMirrorToMdast,
} from "~/lib/markdown";

function roundTrip(markdown: string): string {
  const registry = new RegistryBuilder().addBase();
  for (const [key, handler] of Object.entries(editorCoreMarkdown.mdastToPm?.block ?? {}))
    registry.addMdastBlockHandler(key, handler);
  for (const [key, handler] of Object.entries(editorCoreMarkdown.mdastToPm?.inline ?? {}))
    registry.addMdastInlineHandler(key, handler);
  for (const [key, handler] of Object.entries(editorCoreMarkdown.pmToMdast?.block ?? {}))
    registry.addPmBlockHandler(key, handler);
  for (const [key, handler] of Object.entries(editorCoreMarkdown.pmToMdast?.inline ?? {}))
    registry.addPmInlineHandler(key, handler);
  for (const [key, handler] of Object.entries(editorCoreMarkdown.pmToMdast?.mark ?? {}))
    registry.addPmMarkHandler(key, handler);
  const processor = createProcessor({ remarkPlugins: editorCoreMarkdown.remarkPlugins });
  const built = registry.build();
  return processor.stringify(
    proseMirrorToMdast(mdastToProseMirror(processor.parse(markdown), built), built),
  );
}

describe("planner task source", () => {
  it("extracts nested GFM tasks while ignoring code and YAML", () => {
    const source =
      "---\ntitle: '- [ ] metadata'\n---\n\n- [ ] **Parent**\n  - [x] Child\n\n```md\n- [ ] example\n```\n";
    expect(extractTasks(source, "notes/a.md").map((task) => [task.title, task.checked])).toEqual([
      ["Parent", false],
      ["Child", true],
    ]);
  });

  it("adds a lazy ID and changes only the selected duplicate-title task", () => {
    const source = "# 계획\r\n\r\n- [ ] Same\r\n- [ ] Same\r\n";
    const task = extractTasks(source, "a.md")[1];
    const updated = updateTaskMarkdown(source, task, {
      checked: true,
      metadata: { dueDate: "2026-09-08" },
    });
    expect(updated).toMatch(/^# 계획\r\n\r\n- \[ \] Same\r\n- \[x\] Same <!-- kuku-task: /);
    const next = extractTasks(updated, "a.md");
    expect(next[0].metadata).toBeNull();
    expect(next[1].metadata?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(next[1].metadata?.dueDate).toBe("2026-09-08");
  });

  it("refuses stale transient locations", () => {
    const source = "- [ ] One\n- [ ] Two\n";
    expect(() =>
      updateTaskMarkdown(`Text\n\n${source}`, extractTasks(source, "a.md")[0], { checked: true }),
    ).toThrow(/changed/);
  });

  it("finds a stable task after note content moves and preserves unknown fields", () => {
    const source =
      '- [ ] Original <!-- kuku-task: {"id":"task-a","dueDate":"2026-09-08","future":{"value":2}} -->\n';
    const task = extractTasks(source, "a.md")[0];
    const moved = `# Title\n\n${source.replace("Original", "Renamed")}`;
    const updated = updateTaskMarkdown(moved, task, {
      metadata: { dueDate: undefined, plannedDate: "2026-09-09" },
    });
    expect(extractTasks(updated, "a.md")[0]).toMatchObject({
      title: "Renamed",
      metadata: { id: "task-a", plannedDate: "2026-09-09", future: { value: 2 } },
    });
    expect(updated).not.toContain("dueDate");
  });

  it("does not choose an arbitrary source when IDs collide", () => {
    const source = '- [ ] One <!-- kuku-task: {"id":"same"} -->\n';
    expect(() =>
      updateTaskMarkdown(source.repeat(2), extractTasks(source, "a.md")[0], { checked: true }),
    ).toThrow(/duplicate ID/);
  });

  it("keeps a parent's metadata separate from nested children", () => {
    const source = '- [ ] Parent\n  - [ ] Child <!-- kuku-task: {"id":"child"} -->\n';
    const tasks = extractTasks(source, "a.md");
    expect(tasks[0].metadata).toBeNull();
    const updated = updateTaskMarkdown(source, tasks[0], { checked: true });
    expect(updated).toContain('\n  - [ ] Child <!-- kuku-task: {"id":"child"} -->');
    expect(extractTasks(updated, "a.md")[0].metadata?.id).not.toBe("child");
  });

  it("supports tasks in blockquotes and multiline titles", () => {
    const source = "> - [ ] A long\n>   task\n";
    const updated = updateTaskMarkdown(source, extractTasks(source, "a.md")[0], { checked: true });
    expect(updated.startsWith("> - [x] A long\n>   task <!-- kuku-task:")).toBe(true);
  });

  it("validates calendar dates and complete zoned time ranges", () => {
    expect(
      parseTaskMetadataComment('<!-- kuku-task: {"id":"a","dueDate":"2026-02-30"} -->'),
    ).toBeNull();
    expect(() => taskMetadataComment({ id: "a", scheduledStart: "2026-09-04T09:00:00" })).toThrow();
    expect(() =>
      taskMetadataComment({
        id: "a",
        scheduledStart: "2026-09-04T09:00:00Z",
        scheduledEnd: "2026-09-04T08:00:00Z",
      }),
    ).toThrow();
    expect(
      parseTaskMetadataComment(
        taskMetadataComment({
          id: "a",
          dueDate: "2028-02-29",
          scheduledStart: "2026-09-04T09:00:00Z",
          scheduledEnd: "2026-09-04T10:00:00Z",
          timeZone: "Asia/Seoul",
        }),
      ),
    ).toMatchObject({ timeZone: "Asia/Seoul" });
  });

  it("refuses malformed existing metadata rather than appending another marker", () => {
    const source = '- [ ] Task <!-- kuku-task: {"id":"a","dueDate":"broken"} -->\n';
    expect(() =>
      updateTaskMarkdown(source, extractTasks(source, "a.md")[0], { checked: true }),
    ).toThrow(/invalid/);
  });
});

describe("core-only Markdown preservation", () => {
  it("preserves task metadata, nested task dates and frontmatter without optional plugins", () => {
    const source =
      '---\ntitle: Tasks\ncustom:\n  value: preserved\n---\n\n- [ ] **Parent** <!-- kuku-task: {"id":"parent","plannedDate":"2026-09-04"} -->\n  - [x] Child <!-- kuku-task: {"id":"child","dueDate":"2026-09-08"} -->\n';
    const first = roundTrip(source);
    expect(roundTrip(first)).toBe(first);
    expect(first.startsWith("---\ntitle: Tasks\ncustom:\n  value: preserved\n---")).toBe(true);
    expect(extractTasks(first, "a.md").map((task) => task.metadata)).toEqual([
      { id: "parent", plannedDate: "2026-09-04" },
      { id: "child", dueDate: "2026-09-08" },
    ]);
    expect(first).not.toContain("&lt;");
  });
});

describe("Planner task title and deletion", () => {
  it("renames only the first paragraph while preserving descendant tasks and details", () => {
    const source =
      '- [ ] Parent <!-- kuku-task: {"id":"parent","timeBlockLinkId":"binding-1"} -->\n\n  Details stay.\n\n  - [x] Child <!-- kuku-task: {"id":"child"} -->\n\nAfter.\n';
    const updated = updateTaskMarkdown(source, extractTasks(source, "a.md")[0], {
      title: "Renamed <task> &amp; **literal**",
    });
    expect(extractTasks(updated, "a.md").map((task) => task.title)).toEqual([
      "Renamed <task> &amp; **literal**",
      "Child",
    ]);
    expect(updated.slice(updated.indexOf("\n"))).toBe(source.slice(source.indexOf("\n")));
    expect(extractTasks(updated, "a.md")[0].metadata).toEqual({
      id: "parent",
      timeBlockLinkId: "binding-1",
    });
  });

  it("promotes nested child tasks and their descendants while keeping details", () => {
    const source =
      '- [ ] Parent <!-- kuku-task: {"id":"parent"} -->\n\n  Details stay.\n\n  - [x] Child <!-- kuku-task: {"id":"child"} -->\n    - [ ] Grandchild\n- [ ] Sibling\n\nAfter.\n';
    const updated = deleteTaskMarkdown(source, extractTasks(source, "a.md")[0]);
    expect(updated).toBe(
      'Details stay.\n\n- [x] Child <!-- kuku-task: {"id":"child"} -->\n  - [ ] Grandchild\n- [ ] Sibling\n\nAfter.\n',
    );
    expect(extractTasks(updated, "a.md").map((task) => task.title)).toEqual([
      "Child",
      "Grandchild",
      "Sibling",
    ]);
  });

  it("preserves blockquote structure when promoting nested tasks", () => {
    const source =
      "> Intro.\n>\n> - [ ] Parent\n>   - [ ] Child\n>     - [ ] Grandchild\n> - [ ] Sibling\n>\n> After.\n";
    const updated = deleteTaskMarkdown(source, extractTasks(source, "a.md")[0]);
    expect(updated).toBe(
      "> Intro.\n>\n> - [ ] Child\n>   - [ ] Grandchild\n> - [ ] Sibling\n>\n> After.\n",
    );
  });

  it("retains the parent list when deleting one nested task", () => {
    const source = "- Container\n  - [ ] Delete\n    - [ ] Child\n  - [ ] Sibling\n";
    const updated = deleteTaskMarkdown(source, extractTasks(source, "a.md")[0]);
    expect(updated).toBe("- Container\n  - [ ] Child\n  - [ ] Sibling\n");
  });

  it("retains details as separate blocks after a preceding list item", () => {
    const source =
      "- [ ] Previous\n- [ ] Delete\n\n  Detail paragraph.\n\n  ```js\n  const n = 1;\n  ```\n\nFollowing.\n";
    const updated = deleteTaskMarkdown(source, extractTasks(source, "a.md")[1]);
    expect(updated).toBe(
      "- [ ] Previous\n\nDetail paragraph.\n\n```js\nconst n = 1;\n```\n\nFollowing.\n",
    );
    expect(extractTasks(updated, "a.md")[0].title).toBe("Previous");
  });

  it("keeps CRLF and the original child identity on promotion", () => {
    const source =
      '# Notes\r\n\r\n- [ ] Delete\r\n  - [ ] Child <!-- kuku-task: {"id":"child"} -->\r\n\r\nTail\r\n';
    const updated = deleteTaskMarkdown(source, extractTasks(source, "a.md")[0]);
    expect(updated).toBe(
      '# Notes\r\n\r\n- [ ] Child <!-- kuku-task: {"id":"child"} -->\r\n\r\nTail\r\n',
    );
  });

  it("preserves indented code details when removing their task container", () => {
    const source = "- [ ] Delete\n\n      const value = 1;\n      return value;\n\nAfter.\n";
    const updated = deleteTaskMarkdown(source, extractTasks(source, "a.md")[0]);
    expect(updated).toBe("    const value = 1;\n    return value;\n\nAfter.\n");
  });

  it("validates time block link IDs instead of interpreting malformed metadata", () => {
    expect(
      parseTaskMetadataComment('<!-- kuku-task: {"id":"task","timeBlockLinkId":42} -->'),
    ).toBeNull();
    expect(
      parseTaskMetadataComment('<!-- kuku-task: {"id":"task","timeBlockLinkId":"binding-1"} -->'),
    ).toMatchObject({ timeBlockLinkId: "binding-1" });
  });

  it("rejects stale or duplicate task deletion", () => {
    const source = '- [ ] First <!-- kuku-task: {"id":"duplicate"} -->\n';
    const task = extractTasks(source, "a.md")[0];
    expect(() => deleteTaskMarkdown(source.repeat(2), task)).toThrow(/duplicate/);
    const transient = extractTasks("- [ ] Transient\n", "a.md")[0];
    expect(() => deleteTaskMarkdown("Text\n\n- [ ] Transient\n", transient)).toThrow(/changed/);
  });
});
