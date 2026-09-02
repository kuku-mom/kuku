import { Schema } from "prosekit/pm/model";
import { EditorState, Plugin, TextSelection } from "prosekit/pm/state";
// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";

import { editorCoreMarkdown } from "~/plugins/builtin/core_editor/markdown_handlers";
import {
  buildMarkdownService,
  contributeMarkdown,
  getMarkdownService,
} from "~/plugins/markdown_service";

import type { Transcript } from "./types";

import { MeetingDocumentBridge } from "./document_bridge";
import {
  createMeetingTranscriptPlugin,
  getMeetingPluginState,
  meetingTranscriptPluginKey,
} from "./meeting_transcript_plugin";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    text: { group: "inline" },
    paragraph: { content: "inline*", group: "block" },
    heading: { content: "inline*", group: "block", attrs: { level: { default: 2 } } },
  },
  marks: { bold: {} },
});
function document(text: string, plugins: Plugin[] = []) {
  let state = EditorState.create({
    schema,
    doc: schema.node("doc", null, [
      schema.node("paragraph", null, text ? schema.text(text) : undefined),
    ]),
    plugins: [createMeetingTranscriptPlugin(), ...plugins],
  });
  return {
    getState: () => state,
    dispatch: (tr: ReturnType<typeof state.tr.setMeta>) => {
      state = state.applyTransaction(tr).state;
    },
  };
}
const payload = (kind: "update" | "final", text: string): Transcript => ({
  sessionId: "one",
  kind,
  stableText: text,
  unstableText: kind === "update" ? "partial" : "",
  speakerId: 1,
  segments: [{ speaker: 1, text }],
  speakerLimitWarning: false,
});

beforeAll(() => {
  contributeMarkdown("meeting-bridge-test", editorCoreMarkdown);
  buildMarkdownService();
});

describe("meeting document ownership", () => {
  it("accepts transcript changes when normalization appends an outside edit", () => {
    const normalizer = new Plugin({
      appendTransaction: (transactions, _oldState, nextState) => {
        if (!transactions.some((transaction) => transaction.getMeta(meetingTranscriptPluginKey)))
          return null;
        return nextState.tr.insertText("!", 1);
      },
    });
    const original = document("Memo", [normalizer]);
    const bridge = new MeetingDocumentBridge(original, "one", "Meeting");

    bridge.begin();
    expect(() => bridge.apply(payload("update", "Live text"))).not.toThrow();
    expect(() => bridge.apply(payload("final", "Final text"))).not.toThrow();

    expect(original.getState().doc.textContent).toContain("!!!Memo");
    expect(original.getState().doc.textContent).toContain("Final text");
  });

  it("removes a failed meeting section and restores the empty block it replaced", () => {
    const original = document("");
    const before = original.getState().doc;
    const bridge = new MeetingDocumentBridge(original, "one", "Meeting");
    bridge.begin();
    bridge.apply(payload("update", "Temporary transcript"));
    bridge.abort();

    expect(original.getState().doc.eq(before)).toBe(true);
    expect(getMeetingPluginState(original.getState())).toBeNull();
  });

  it("removes only the failed meeting and keeps surrounding edits", () => {
    const original = document("Keep this memo");
    const bridge = new MeetingDocumentBridge(original, "one", "Meeting");
    bridge.begin();
    const range = getMeetingPluginState(original.getState());
    if (!range) throw new Error("Missing meeting range");
    original.dispatch(
      original
        .getState()
        .tr.insert(range.to, schema.node("paragraph", null, schema.text("Keep side memo"))),
    );
    bridge.apply(payload("update", "Temporary transcript"));
    bridge.abort();

    expect(original.getState().doc.textContent).toContain("Keep this memo");
    expect(original.getState().doc.textContent).toContain("Keep side memo");
    expect(original.getState().doc.textContent).not.toContain("Meeting");
    expect(original.getState().doc.textContent).not.toContain("Temporary transcript");
  });

  it("retries the same final after an editor rejects its first application", () => {
    const original = document("Memo");
    let reject = false;
    const bridge = new MeetingDocumentBridge(
      {
        getState: original.getState,
        dispatch: (tr) => {
          if (!reject) original.dispatch(tr);
        },
      },
      "one",
      "Meeting",
    );
    bridge.begin();
    reject = true;
    expect(() => bridge.apply(payload("final", "Final text must survive"))).toThrow("rejected");
    reject = false;
    expect(bridge.apply(payload("final", "Final text must survive"))).toBe(true);
    expect(original.getState().doc.textContent).toContain("Final text must survive");
  });

  it("preserves surrounding notes across hundreds of corrected and duplicate updates", () => {
    const original = document("Keep this memo.");
    const bridge = new MeetingDocumentBridge(original, "one", "Meeting");
    bridge.begin();
    const reference: string[] = [];
    for (let index = 0; index < 300; index++) {
      reference.push(`회의 ${index} 日本語 English 👩🏽‍💻.`);
      const text = reference.join(" ");
      bridge.apply(payload("update", text));
      bridge.apply(payload("update", text));
      if (index % 50 === 0) {
        const range = getMeetingPluginState(original.getState());
        if (!range) throw new Error("Missing range");
        original.dispatch(
          original
            .getState()
            .tr.insert(range.to, schema.node("paragraph", null, schema.text(`Side memo ${index}`))),
        );
      }
    }
    bridge.apply(payload("final", reference.join(" ")));
    const text = original.getState().doc.textContent;
    expect(text).toContain(reference.join(" "));
    expect(text).toContain("Keep this memo.");
    for (let index = 0; index < 300; index += 50) expect(text).toContain(`Side memo ${index}`);
  });

  it("does not replace stable nodes for duplicate snapshots or partial-only changes", () => {
    const original = document("Memo");
    const bridge = new MeetingDocumentBridge(original, "one", "Meeting");
    bridge.begin();
    bridge.apply(payload("update", "네"));
    const doc = original.getState().doc;
    bridge.apply({ ...payload("update", "네"), unstableText: "다음 문장" });
    expect(original.getState().doc).toBe(doc);
    expect(getMeetingPluginState(original.getState())?.partial).toBe("다음 문장");
    bridge.apply(payload("update", "네"));
    expect(original.getState().doc).toBe(doc);
  });

  it("changes the captured document only, keeps surrounding edits, and applies final once", () => {
    const original = document("Original note");
    const other = document("Another tab");
    const bridge = new MeetingDocumentBridge(original, "one", "Meeting");
    bridge.begin();
    original.dispatch(original.getState().tr.insertText("Edited: ", 1));
    bridge.apply(payload("update", "First sentence"));
    other.dispatch(other.getState().tr.insertText("Other: ", 1));
    expect(bridge.apply(payload("final", "First sentence. Last sentence."))).toBe(true);
    expect(bridge.apply(payload("final", "Duplicate"))).toBe(false);
    bridge.unlock();
    const markdown = getMarkdownService()?.stringify(original.getState().doc.toJSON());
    expect(markdown).toContain("Edited: Original note");
    expect(markdown).toContain("First sentence. Last sentence.");
    expect(markdown).not.toContain("partial");
    expect(other.getState().doc.textContent).toBe("Other: Another tab");
    expect(getMeetingPluginState(original.getState())).toBeNull();
  });

  it("prefers complete final text when speaker segments omit words", () => {
    const original = document("Note");
    const bridge = new MeetingDocumentBridge(original, "one", "Meeting");
    bridge.begin();
    bridge.apply({
      ...payload("final", "All words must survive."),
      segments: [{ speaker: 2, text: "All words" }],
    });
    expect(original.getState().doc.textContent).toContain("All words must survive.");
    expect(original.getState().doc.textContent).not.toContain("Speaker 2");
  });

  it("preserves final speaker segments when stable text is empty", () => {
    const original = document("Note");
    const bridge = new MeetingDocumentBridge(original, "one", "Meeting");
    bridge.begin();
    bridge.apply({
      ...payload("final", ""),
      segments: [{ speaker: 2, text: "Segment text must survive." }],
    });
    expect(original.getState().doc.textContent).toContain("Segment text must survive.");
    expect(original.getState().doc.textContent).toContain("Speaker 1");
  });

  it("protects only the transcript range and maps the range around user edits", () => {
    const original = document("Note");
    const bridge = new MeetingDocumentBridge(original, "one", "Meeting");
    bridge.begin();
    bridge.apply(payload("update", "Protected text"));
    const before = original.getState().doc;
    const range = getMeetingPluginState(original.getState());
    if (!range) throw new Error("Expected a protected transcript range");
    original.dispatch(original.getState().tr.delete(range.from, range.to));
    expect(original.getState().doc).toBe(before);
    original.dispatch(original.getState().tr.insertText("User edit ", 1));
    bridge.apply(payload("final", "Final text"));
    expect(original.getState().doc.textContent).toContain("User edit Note");
    expect(original.getState().doc.textContent).toContain("Final text");
  });

  it("inserts after the selected block without deleting a nonempty selection", () => {
    const original = document("Keep selected text");
    original.dispatch(
      original.getState().tr.setSelection(TextSelection.create(original.getState().doc, 1, 5)),
    );
    new MeetingDocumentBridge(original, "one", "Meeting").begin();
    expect(original.getState().doc.firstChild?.textContent).toBe("Keep selected text");
  });
});
