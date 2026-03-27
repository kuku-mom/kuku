import { Show, createSignal, type JSX } from "solid-js";

import { canOpenApprovalDiff, closeApprovalDiff, openApprovalDiff } from "../approval_diff";
import { resolveApproval } from "../chat_store";
import type { ChatApprovalMessage } from "../types";
import {
  getApprovalStatusLabel,
  getApprovalStatusTone,
  getApprovalSummary,
  type ChatUiTone,
} from "../ui_state";

const STATUS_TONE_CLASSES: Record<ChatUiTone, string> = {
  neutral: "border-border bg-bg-primary/60 text-text-secondary",
  accent: "border-info-border bg-info-bg text-info",
  warning: "border-warning-border bg-warning-bg text-warning",
  danger: "border-error-border bg-error-bg text-error",
  success: "border-success-border bg-success-bg text-success",
};

function ApprovalWidget(props: {
  sessionId: string;
  item: ChatApprovalMessage;
  onClose?: () => void;
}): JSX.Element {
  const statusLabel = () => getApprovalStatusLabel(props.item);
  const statusTone = () => getApprovalStatusTone(props.item);
  const isPending = () => props.item.status === "pending";
  const [showDetail, setShowDetail] = createSignal(false);

  return (
    <div
      class="rounded-xs border p-3 text-xs"
      classList={{
        "border-accent/50 bg-accent-dim/40": isPending(),
        "border-border bg-bg-secondary": !isPending(),
      }}
    >
      {/* tool name + status label */}
      <div class="flex items-center justify-between gap-3">
        <span class="font-medium text-text-primary">{props.item.toolName}</span>
        <div
          class={`rounded-xs border px-2 py-0.5 text-[0.6875rem] ${STATUS_TONE_CLASSES[statusTone()]}`}
        >
          {statusLabel()}
        </div>
      </div>

      {/* preview */}
      <div class="mt-1 truncate text-[0.6875rem] text-text-secondary">
        {getApprovalSummary(props.item)}
      </div>

      {/* detail toggle */}
      <button
        type="button"
        class="mt-2 text-[0.6875rem] text-text-muted underline underline-offset-2 transition-colors hover:text-text-secondary"
        onClick={() => setShowDetail(!showDetail())}
      >
        {showDetail() ? "Hide details" : "Show details"}
      </button>

      {/* mutation JSON */}
      <Show when={showDetail()}>
        <pre class="mt-2 max-h-64 overflow-auto rounded-xs bg-bg-primary/70 p-2 text-[0.6875rem] wrap-break-word whitespace-pre-wrap text-text-primary">
          {JSON.stringify(props.item.mutation, null, 2)}
        </pre>
      </Show>

      <Show when={props.item.error}>
        <p class="mt-2 text-[0.6875rem] text-error">{props.item.error}</p>
      </Show>

      {/* buttons — only pending */}
      <Show when={isPending()}>
        <div class="mt-3 flex items-center gap-2">
          <Show when={canOpenApprovalDiff(props.item.mutation, props.item.toolName)}>
            <button
              type="button"
              class="rounded-xs border border-accent-dim bg-bg-secondary px-3 py-1.5 text-[0.6875rem] text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
              onClick={() => void openApprovalDiff(props.item.mutation, props.item.toolName)}
            >
              Open Diff
            </button>
          </Show>
          <button
            type="button"
            class="rounded-xs border border-success-border bg-success-bg px-3 py-1.5 text-[0.6875rem] text-success transition-colors hover:opacity-80"
            onClick={() => {
              const { mutation, toolName, callId } = props.item;
              const { sessionId, onClose } = props;
              void (async () => {
                await resolveApproval(sessionId, callId, "Approve");
                closeApprovalDiff(mutation, toolName);
                onClose?.();
              })();
            }}
          >
            Approve
          </button>
          <button
            type="button"
            class="rounded-xs border border-error-border bg-error-bg px-3 py-1.5 text-[0.6875rem] text-error transition-colors hover:opacity-80"
            onClick={() => {
              const { mutation, toolName, callId } = props.item;
              const { sessionId, onClose } = props;
              void (async () => {
                await resolveApproval(sessionId, callId, "Reject");
                closeApprovalDiff(mutation, toolName);
                onClose?.();
              })();
            }}
          >
            Reject
          </button>
        </div>
      </Show>
    </div>
  );
}

export { ApprovalWidget };
