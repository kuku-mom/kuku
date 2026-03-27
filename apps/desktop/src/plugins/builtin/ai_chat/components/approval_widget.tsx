import { Show, type JSX } from "solid-js";

import { canOpenApprovalDiff, openApprovalDiff } from "../approval_diff";
import { resolveApproval, toggleApprovalExpanded } from "../chat_store";
import type { ChatApprovalMessage } from "../types";
import {
  getApprovalStatusLabel,
  getApprovalStatusTone,
  getApprovalSummary,
  type ChatUiTone,
} from "../ui_state";

const STATUS_TONE_CLASSES: Record<ChatUiTone, string> = {
  neutral: "border-border bg-bg-primary/60 text-text-secondary",
  accent: "border-accent/30 bg-accent/10 text-accent",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  danger: "border-red-500/30 bg-red-500/10 text-red-300",
  success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
};

function ApprovalWidget(props: { sessionId: string; item: ChatApprovalMessage }): JSX.Element {
  const statusLabel = () => getApprovalStatusLabel(props.item);
  const statusTone = () => getApprovalStatusTone(props.item);

  if (props.item.status !== "pending") {
    return (
      <div class="rounded-xl border border-border bg-bg-secondary p-3 text-xs">
        <button
          type="button"
          class="w-full text-left"
          onClick={() => toggleApprovalExpanded(props.sessionId, props.item.callId)}
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="font-medium text-text-primary">{props.item.toolName}</div>
              <p class="mt-1 truncate text-[0.6875rem] text-text-muted">
                {getApprovalSummary(props.item)}
              </p>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <div
                class={`rounded-full border px-2 py-0.5 text-[0.6875rem] ${STATUS_TONE_CLASSES[statusTone()]}`}
              >
                {statusLabel()}
              </div>
              <span class="text-[0.6875rem] text-text-muted">
                {props.item.expanded ? "Hide" : "Show"}
              </span>
            </div>
          </div>
        </button>
        <Show when={props.item.expanded}>
          <pre class="mt-3 max-h-32 overflow-auto rounded-lg bg-bg-primary/70 p-2 text-[0.6875rem] wrap-break-word whitespace-pre-wrap text-text-muted">
            {JSON.stringify(props.item.mutation, null, 2)}
          </pre>
          <Show when={props.item.error}>
            <p class="mt-2 text-[0.6875rem] text-red-400">{props.item.error}</p>
          </Show>
        </Show>
      </div>
    );
  }

  return (
    <div class="rounded-xs border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="font-medium text-text-primary">{props.item.toolName}</div>
          <div class="mt-1 text-[0.6875rem] text-text-muted">{props.item.previewText}</div>
        </div>
        <div class="rounded-md border border-amber-500/40 px-2 py-0.5 text-[0.6875rem] text-amber-300">
          {statusLabel()}
        </div>
      </div>

      <pre class="mt-2 max-h-32 overflow-auto rounded-lg bg-bg-primary/70 p-2 text-[0.6875rem] wrap-break-word whitespace-pre-wrap text-text-muted">
        {JSON.stringify(props.item.mutation, null, 2)}
      </pre>

      <Show when={props.item.error}>
        <p class="mt-2 text-[0.6875rem] text-red-400">{props.item.error}</p>
      </Show>

      <div class="mt-3 flex items-center gap-2">
        <Show when={canOpenApprovalDiff(props.item.mutation, props.item.toolName)}>
          <button
            type="button"
            class="rounded-md border border-border bg-bg-secondary px-3 py-1.5 text-[0.6875rem] text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            onClick={() => void openApprovalDiff(props.item.mutation, props.item.toolName)}
          >
            Open Diff
          </button>
        </Show>
        <button
          type="button"
          class="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-[0.6875rem] text-emerald-300 transition-colors hover:bg-emerald-500/20"
          onClick={() => void resolveApproval(props.sessionId, props.item.callId, "Approve")}
        >
          Approve
        </button>
        <button
          type="button"
          class="rounded-md border border-border bg-bg-secondary px-3 py-1.5 text-[0.6875rem] text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          onClick={() => void resolveApproval(props.sessionId, props.item.callId, "Reject")}
        >
          Reject
        </button>
      </div>
    </div>
  );
}

export { ApprovalWidget };
