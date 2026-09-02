/* eslint-disable unicorn/no-array-method-this-argument -- ProseMirror Mapping.map takes a position and association, not an array callback. */
import { definePlugin, type Extension } from "prosekit/core";
import { Plugin, PluginKey, type Transaction } from "prosekit/pm/state";
import { AddMarkStep, RemoveMarkStep } from "prosekit/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "prosekit/pm/view";

import { markAutomaticDocumentChange } from "~/plugins/editor_change_origin";

interface MeetingPluginState {
  sessionId: string;
  from: number;
  to: number;
  partial: string;
  revealFrom?: number;
  revealTo?: number;
  revealId?: number;
}

type MeetingPluginAction =
  | { type: "set"; state: MeetingPluginState }
  | { type: "clear"; sessionId: string };

const meetingTranscriptPluginKey = new PluginKey<MeetingPluginState | null>(
  "kukuMeetingTranscript",
);

function transactionTouchesMeetingRange(
  transaction: Transaction,
  from: number,
  to: number,
): boolean {
  let mappedFrom = from;
  let mappedTo = to;
  for (const step of transaction.steps) {
    // Mark steps have empty position maps, but still edit protected content.
    if (
      (step instanceof AddMarkStep || step instanceof RemoveMarkStep) &&
      step.from < mappedTo &&
      step.to > mappedFrom
    )
      return true;
    const stepMap = step.getMap();
    let touches = false;
    stepMap.forEach((oldStart, oldEnd) => {
      const deletesProtectedContent =
        oldEnd > oldStart && oldStart < mappedTo && oldEnd > mappedFrom;
      const insertsInsideProtectedContent =
        oldEnd === oldStart && oldStart > mappedFrom && oldStart < mappedTo;
      if (deletesProtectedContent || insertsInsideProtectedContent) touches = true;
    });
    if (touches) return true;
    mappedFrom = stepMap.map(mappedFrom, 1);
    mappedTo = stepMap.map(mappedTo, -1);
  }
  return false;
}

function createMeetingTranscriptPlugin() {
  return new Plugin<MeetingPluginState | null>({
    key: meetingTranscriptPluginKey,
    state: {
      init: () => null,
      toJSON: (value) => value,
      fromJSON: (_config, value) => value as MeetingPluginState | null,
      apply(transaction, previous) {
        const action = transaction.getMeta(meetingTranscriptPluginKey) as
          | MeetingPluginAction
          | undefined;
        if (action?.type === "set") return action.state;
        if (action?.type === "clear" && previous?.sessionId === action.sessionId) return null;
        if (!previous) return null;
        return {
          ...previous,
          from: transaction.mapping.map(previous.from, 1),
          to: transaction.mapping.map(previous.to, -1),
          revealFrom:
            previous.revealFrom == null
              ? undefined
              : transaction.mapping.map(previous.revealFrom, -1),
          revealTo:
            previous.revealTo == null ? undefined : transaction.mapping.map(previous.revealTo, 1),
        };
      },
    },
    props: {
      decorations(state) {
        const meeting = meetingTranscriptPluginKey.getState(state);
        if (!meeting) return null;
        const decorations: Decoration[] = [];
        const revealFrom = Math.max(0, Math.min(state.doc.content.size, meeting.revealFrom ?? 0));
        const revealTo = Math.max(
          revealFrom,
          Math.min(state.doc.content.size, meeting.revealTo ?? 0),
        );
        if (revealTo > revealFrom) {
          decorations.push(
            Decoration.inline(
              revealFrom,
              revealTo,
              {
                class: "meeting-transcript-reveal",
                "aria-label": "New transcript text",
              },
              { key: `meeting-reveal-${meeting.sessionId}-${meeting.revealId ?? 0}` },
            ),
          );
        }
        if (meeting.partial) {
          const position = Math.max(0, Math.min(state.doc.content.size, meeting.to));
          decorations.push(
            Decoration.widget(
              position,
              () => {
                const element = document.createElement("span");
                element.className = "meeting-transcript-partial";
                element.dataset.meetingSession = meeting.sessionId;
                return element;
              },
              { side: -1, key: `meeting-partial-${meeting.sessionId}` },
            ),
          );
        }
        return decorations.length ? DecorationSet.create(state.doc, decorations) : null;
      },
    },
    view(view) {
      const syncPartialText = (currentView: EditorView) => {
        const meeting = meetingTranscriptPluginKey.getState(currentView.state);
        const element = meeting?.partial
          ? ([...currentView.dom.querySelectorAll<HTMLElement>(".meeting-transcript-partial")].find(
              (candidate) => candidate.dataset.meetingSession === meeting.sessionId,
            ) ?? null)
          : null;
        if (meeting?.partial && element) element.textContent = meeting.partial;
      };

      syncPartialText(view);
      return {
        update: syncPartialText,
      };
    },
    filterTransaction(transaction, state) {
      const meeting = meetingTranscriptPluginKey.getState(state);
      if (!meeting || !transaction.docChanged || transaction.getMeta(meetingTranscriptPluginKey))
        return true;
      return !transactionTouchesMeetingRange(transaction, meeting.from, meeting.to);
    },
  });
}

function defineMeetingTranscriptPlugin(): Extension {
  return definePlugin(createMeetingTranscriptPlugin());
}

function setMeetingPluginState(transaction: Transaction, state: MeetingPluginState): Transaction {
  return markAutomaticDocumentChange(transaction).setMeta(meetingTranscriptPluginKey, {
    type: "set",
    state,
  } satisfies MeetingPluginAction);
}

function clearMeetingPluginState(transaction: Transaction, sessionId: string): Transaction {
  return markAutomaticDocumentChange(transaction).setMeta(meetingTranscriptPluginKey, {
    type: "clear",
    sessionId,
  } satisfies MeetingPluginAction);
}

function getMeetingPluginState(state: Parameters<typeof meetingTranscriptPluginKey.getState>[0]) {
  return meetingTranscriptPluginKey.getState(state);
}

export {
  clearMeetingPluginState,
  createMeetingTranscriptPlugin,
  defineMeetingTranscriptPlugin,
  getMeetingPluginState,
  meetingTranscriptPluginKey,
  setMeetingPluginState,
  transactionTouchesMeetingRange,
};
export type { MeetingPluginState };
