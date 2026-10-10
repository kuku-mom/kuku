// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "prosekit/pm/model";
import { EditorState, Plugin } from "prosekit/pm/state";
import {
  createDocumentChangeOriginPlugin,
  hasUserDocumentChange,
  markAutomaticDocumentChange,
} from "./editor_change_origin";
import { charCount, isTyping, recordTyping, resetTyping, savedCharCount } from "~/stores/typing";
import { MeetingDocumentBridge } from "./builtin/meeting_notes/document_bridge";
import { createMeetingTranscriptPlugin } from "./builtin/meeting_notes/meeting_transcript_plugin";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    text: { group: "inline" },
    paragraph: { content: "inline*", group: "block" },
    heading: { content: "inline*", group: "block", attrs: { level: { default: 2 } } },
  },
  marks: { bold: {} },
});
afterEach(() => {
  resetTyping();
  vi.useRealTimers();
});

describe("typing indicator origin", () => {
  it("excludes live/final meeting text without suppressing surrounding user typing", () => {
    vi.useFakeTimers();
    let state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [schema.node("paragraph", null, schema.text("Memo"))]),
      plugins: [createDocumentChangeOriginPlugin(), createMeetingTranscriptPlugin()],
    });
    const document = {
      getState: () => state,
      dispatch: (tr: typeof state.tr) => {
        const previous = state;
        state = state.applyTransaction(tr).state;
        if (!previous.doc.eq(state.doc) && hasUserDocumentChange(previous, state)) recordTyping();
      },
    };
    const meeting = new MeetingDocumentBridge(document, "session", "Meeting");
    meeting.begin();
    const update = {
      sessionId: "session",
      kind: "update" as const,
      stableText: "네",
      unstableText: "다음",
      speakerId: null,
      segments: [],
      speakerLimitWarning: false,
    };
    meeting.apply(update);
    expect(isTyping()).toBe(false);
    expect(charCount()).toBe(0);
    document.dispatch(state.tr.insertText("1", 1));
    expect(charCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    meeting.apply({ ...update, stableText: "네. 다음 주에 만나요." });
    vi.advanceTimersByTime(500);
    expect(isTyping()).toBe(false);
    expect(savedCharCount()).toBe(1);
    meeting.apply({
      ...update,
      kind: "final",
      stableText: "네. 다음 주에 만나요.",
      unstableText: "",
    });
    meeting.unlock();
    expect(charCount()).toBe(0);
    expect(savedCharCount()).toBe(1);
  });

  it("inherits the origin for automatic normalization appended to a transaction", () => {
    const normalizer = new Plugin({
      appendTransaction: (transactions, _old, state) =>
        transactions.some((tr) => tr.getMeta("normalize")) ? state.tr.insertText("!", 1) : null,
    });
    const state = EditorState.create({
      schema,
      plugins: [createDocumentChangeOriginPlugin(), normalizer],
    });
    const machine = state.applyTransaction(
      markAutomaticDocumentChange(state.tr.insertText("AI", 1)).setMeta("normalize", true),
    ).state;
    expect(hasUserDocumentChange(state, machine)).toBe(false);
    const user = machine.apply(machine.tr.insertText("User", 1));
    const mixed = user.apply(markAutomaticDocumentChange(user.tr.insertText("AI", 1)));
    expect(hasUserDocumentChange(machine, mixed)).toBe(true);
  });
});
