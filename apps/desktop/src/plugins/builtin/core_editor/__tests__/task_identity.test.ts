import { describe, expect, it } from "vitest";
import { Fragment, Schema, Slice } from "prosekit/pm/model";
import { EditorState } from "prosekit/pm/state";
import { createTaskIdentityPlugin } from "../nodes/list";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*" },
    list: {
      group: "block",
      content: "paragraph block*",
      attrs: { kind: { default: "task" }, taskMetadata: { default: null } },
    },
    text: {},
  },
});
const task = (id: string, title = "First Second") =>
  schema.node(
    "list",
    { taskMetadata: { id, dueDate: "2026-09-08", timeBlockLinkId: `binding-${id}` } },
    [schema.node("paragraph", null, schema.text(title))],
  );

describe("task identity in editor operations", () => {
  it("assigns a new ID to the split item and leaves its scheduling empty", () => {
    const previous = EditorState.create({
      schema,
      doc: schema.node("doc", null, [task("original")]),
      plugins: [createTaskIdentityPlugin()],
    });
    const next = previous.applyTransaction(previous.tr.split(7, 2)).state;
    expect(next.doc.childCount).toBe(2);
    expect(next.doc.child(0).attrs.taskMetadata).toEqual({
      id: "original",
      dueDate: "2026-09-08",
      timeBlockLinkId: "binding-original",
    });
    expect(next.doc.child(1).attrs.taskMetadata).toEqual({ id: expect.any(String) });
    expect(next.doc.child(1).attrs.taskMetadata.id).not.toBe("original");
  });

  it("rekeys copied tasks including nested items without modifying the original slice", () => {
    const plugin = createTaskIdentityPlugin();
    const original = new Slice(Fragment.from(task("copy")), 0, 0);
    const transform = plugin.props.transformPasted;
    if (!transform) throw new Error("Missing paste transform");
    const copied = transform.call(plugin, original, undefined as never, false);
    expect(original.content.firstChild?.attrs.taskMetadata.id).toBe("copy");
    expect(copied.content.firstChild?.attrs.taskMetadata).toEqual({
      id: expect.any(String),
      dueDate: "2026-09-08",
    });
    expect(copied.content.firstChild?.attrs.taskMetadata.id).not.toBe("copy");
    expect(copied.content.firstChild?.attrs.taskMetadata).not.toHaveProperty("timeBlockLinkId");
    expect(copied.content.firstChild?.textContent).toBe("First Second");
  });

  it("clears every copied descendant's link without changing original metadata", () => {
    const plugin = createTaskIdentityPlugin();
    const parent = schema.node(
      "list",
      { taskMetadata: { id: "parent", timeBlockLinkId: "parent-link" } },
      [schema.node("paragraph", null, schema.text("Parent")), task("child")],
    );
    const original = new Slice(Fragment.from(parent), 0, 0);
    const transform = plugin.props.transformPasted;
    if (!transform) throw new Error("Missing paste transform");
    const copied = transform.call(plugin, original, undefined as never, false);
    expect(copied.content.firstChild?.attrs.taskMetadata).not.toHaveProperty("timeBlockLinkId");
    expect(copied.content.firstChild?.child(1).attrs.taskMetadata).not.toHaveProperty(
      "timeBlockLinkId",
    );
    expect(original.content.firstChild?.child(1).attrs.taskMetadata.timeBlockLinkId).toBe(
      "binding-child",
    );
  });

  it("preserves the original binding when a duplicate is inserted before it", () => {
    const previous = EditorState.create({
      schema,
      doc: schema.node("doc", null, [task("original")]),
      plugins: [createTaskIdentityPlugin()],
    });
    const next = previous.applyTransaction(previous.tr.insert(0, task("original", "A copy"))).state;
    expect(next.doc.child(1).attrs.taskMetadata).toEqual(previous.doc.child(0).attrs.taskMetadata);
    expect(next.doc.child(0).attrs.taskMetadata).toEqual({ id: expect.any(String) });
    expect(next.doc.child(0).attrs.taskMetadata.id).not.toBe("original");
  });

  it("keeps a linked task's identity when dragged within the same editor", () => {
    const plugin = createTaskIdentityPlugin();
    const original = task("moving");
    const slice = new Slice(Fragment.from(original), 0, 0);
    const transform = plugin.props.transformPasted;
    if (!transform) throw new Error("Missing paste transform");
    const transformed = transform.call(
      plugin,
      slice,
      { dragging: { slice, move: true } } as never,
      false,
    );
    const previous = EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        original,
        schema.node("paragraph", null, schema.text("After")),
      ]),
      plugins: [plugin],
    });
    const transaction = previous.tr.delete(0, original.nodeSize);
    transaction.insert(transaction.doc.content.size, transformed.content);
    const next = previous.applyTransaction(transaction).state;
    expect(next.doc.lastChild?.attrs.taskMetadata).toEqual(original.attrs.taskMetadata);
  });

  it("does not silently repair externally duplicated IDs during ordinary typing", () => {
    const previous = EditorState.create({
      schema,
      doc: schema.node("doc", null, [task("duplicate"), task("duplicate")]),
      plugins: [createTaskIdentityPlugin()],
    });
    const next = previous.applyTransaction(previous.tr.insertText("x", 2)).state;
    expect(next.doc.child(0).attrs.taskMetadata.id).toBe("duplicate");
    expect(next.doc.child(1).attrs.taskMetadata.id).toBe("duplicate");
  });
});
