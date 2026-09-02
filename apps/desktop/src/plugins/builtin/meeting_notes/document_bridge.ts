import type { EditorState, Transaction } from "prosekit/pm/state";

import { Fragment } from "prosekit/pm/model";

import type { Transcript } from "./types";

import {
  createMeetingDocumentNodes,
  preserveSpeakerBoundaries,
  reconcileMeetingTranscriptSegments,
  type MeetingTranscriptSegment,
} from "./meeting_document";
import {
  clearMeetingPluginState,
  getMeetingPluginState,
  setMeetingPluginState,
} from "./meeting_transcript_plugin";
import { mt } from "./messages";

export interface MeetingDocument {
  getState(): EditorState;
  dispatch(transaction: Transaction): void;
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/gu, " ");
}

/** All mutations use the captured document, never the global active editor. */
export class MeetingDocumentBridge {
  private segments: MeetingTranscriptSegment[] = [];
  private readonly provisionalSpeakers = new Map<number, number>();
  private original: Fragment | null = null;
  private completed = false;

  readonly document: MeetingDocument;
  readonly sessionId: string;
  readonly title: string;
  constructor(document: MeetingDocument, sessionId: string, title: string) {
    this.document = document;
    this.sessionId = sessionId;
    this.title = title;
  }

  begin(): void {
    const state = this.document.getState();
    if (getMeetingPluginState(state)?.sessionId === this.sessionId) return;
    const { $from } = state.selection;
    const block = $from.depth >= 1 ? $from.node(1) : null;
    let from = $from.depth >= 1 ? $from.after(1) : state.selection.to;
    const replaceEmptyBlock = block?.type.name === "paragraph" && block.content.size === 0;
    if (replaceEmptyBlock) from = $from.before(1);
    const to = replaceEmptyBlock ? from + block.nodeSize : from;
    this.original = state.doc.slice(from, to).content;
    const fragment = this.fragment([]);
    const tr = state.tr.replaceWith(from, to, fragment).setMeta("addToHistory", false);
    setMeetingPluginState(tr, {
      sessionId: this.sessionId,
      from,
      to: from + fragment.size,
      partial: "",
    });
    this.document.dispatch(tr);
    if (getMeetingPluginState(this.document.getState())?.sessionId !== this.sessionId)
      throw new Error("The editor rejected the meeting section");
  }

  apply(payload: Transcript): boolean {
    if (payload.sessionId !== this.sessionId || this.completed) return false;
    const state = this.document.getState();
    const range = getMeetingPluginState(state);
    if (range?.sessionId !== this.sessionId) return false;
    let nextSegments: MeetingTranscriptSegment[];
    const completed = payload.kind === "final";
    if (payload.kind === "final") {
      const joined = payload.segments
        .map((s) => s.text.trim())
        .filter(Boolean)
        .join(" ");
      const stable = payload.stableText.trim();
      if (joined && (!stable || normalize(joined) === normalize(stable))) {
        nextSegments = preserveSpeakerBoundaries(this.segments, payload.segments);
      } else {
        nextSegments = stable ? [{ speaker: null, text: stable }] : [];
      }
    } else {
      let speaker = this.segments.at(-1)?.speaker ?? null;
      if (payload.speakerId != null) {
        if (!this.provisionalSpeakers.has(payload.speakerId) && this.provisionalSpeakers.size < 2) {
          this.provisionalSpeakers.set(payload.speakerId, this.provisionalSpeakers.size + 1);
        }
        speaker = this.provisionalSpeakers.get(payload.speakerId) ?? speaker;
      }
      nextSegments = reconcileMeetingTranscriptSegments(
        this.segments,
        payload.stableText,
        speaker ?? undefined,
      );
    }
    const fragment = this.fragment(nextSegments);
    const tr = state.tr.setMeta("addToHistory", false);
    // A partial update or duplicate snapshot must not replace unchanged nodes.
    // Keeping their identity also preserves selection and avoids redundant saves.
    if (!state.doc.slice(range.from, range.to).content.eq(fragment)) {
      tr.replaceWith(range.from, range.to, fragment);
    }
    setMeetingPluginState(tr, {
      sessionId: this.sessionId,
      from: range.from,
      to: range.from + fragment.size,
      partial: completed ? "" : payload.unstableText,
    });
    this.document.dispatch(tr);
    if (!this.document.getState().doc.eq(tr.doc))
      throw new Error("The editor rejected the meeting transcript");
    this.segments = nextSegments;
    this.completed = completed;
    return true;
  }

  unlock(): void {
    this.document.dispatch(
      clearMeetingPluginState(this.document.getState().tr, this.sessionId).setMeta(
        "addToHistory",
        false,
      ),
    );
  }

  /** Remove a meeting that never completed, restoring the exact replaced block. */
  abort(): void {
    const state = this.document.getState();
    const range = getMeetingPluginState(state);
    if (range?.sessionId !== this.sessionId) return;
    const tr = state.tr.replaceWith(range.from, range.to, this.original ?? Fragment.empty);
    clearMeetingPluginState(tr, this.sessionId).setMeta("addToHistory", false);
    this.document.dispatch(tr);
    this.completed = true;
  }

  private fragment(segments: MeetingTranscriptSegment[]): Fragment {
    const schema = this.document.getState().schema;
    return Fragment.fromArray(
      createMeetingDocumentNodes(this.title, segments, mt("speaker")).map((node) =>
        schema.nodeFromJSON(node),
      ),
    );
  }
}
