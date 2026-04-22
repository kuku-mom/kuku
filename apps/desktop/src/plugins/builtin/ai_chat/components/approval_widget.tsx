import { Show, createSignal, type JSX } from "solid-js";

import ScrollArea from "~/components/scroll_area";

import { canOpenApprovalDiff, closeApprovalDiff, openApprovalDiff } from "../approval_diff";
import { resolveApproval } from "../chat_store";
import type { ChatApprovalMessage } from "../types";
import { formatToolIdentity, getToolInfo } from "../tool_identity";
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
  // Guards against double-click → duplicate `ai_resolve_approval` invokes
  // before backend status flips to non-pending. The buttons unmount once
  // `isPending()` becomes false, so no need to reset this signal.
  const [resolving, setResolving] = createSignal(false);
  const toolIdentity = () => formatToolIdentity(props.item.toolId, props.item.toolName);
  const toolInfo = () => getToolInfo(props.item.toolId ?? props.item.toolName);
  const showIdentity = () => toolIdentity() !== toolInfo().label;

  return (
    <div
      class="min-w-0 w-full border-b border-border/40 p-3.5 text-xs"
      classList={{
        "border-accent/40 bg-accent-dim/40": isPending(),
        "border-border/70 bg-bg-secondary": !isPending(),
      }}
    >
      {/* tool name + status label */}
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <span class="block truncate font-medium text-text-primary">{toolInfo().label}</span>
          <Show when={showIdentity()}>
            <span class="block truncate text-[0.625rem] text-text-muted">{toolIdentity()}</span>
          </Show>
        </div>
        <div
          class={`shrink-0 rounded-md border px-2 py-0.5 text-[0.6875rem] font-medium ${STATUS_TONE_CLASSES[statusTone()]}`}
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
        <ScrollArea
          axis="y"
          scrollbarAutoHide="leave"
          class="mt-2 max-h-64 rounded-xs bg-bg-primary/70"
        >
          <pre class="p-2 text-[0.6875rem] wrap-break-word whitespace-pre-wrap text-text-primary">
            {JSON.stringify(props.item.mutation, null, 2)}
          </pre>
        </ScrollArea>
      </Show>

      <Show when={props.item.error}>
        <p class="mt-2 text-[0.6875rem] text-error">{props.item.error}</p>
      </Show>

      {/* buttons — only pending */}
      <Show when={isPending()}>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <Show
            when={canOpenApprovalDiff(props.item.mutation, props.item.toolName, props.item.toolId)}
          >
            <button
              type="button"
              class="rounded-md border border-accent/25 bg-bg-secondary px-3 py-1.5 text-[0.6875rem] text-text-secondary transition hover:bg-ghost-hover hover:text-text-primary"
              onClick={() =>
                void openApprovalDiff(props.item.mutation, props.item.toolName, props.item.toolId)
              }
            >
              Open Diff
            </button>
          </Show>
          <button
            type="button"
            disabled={resolving()}
            class="rounded-md border border-success-border bg-success-bg px-3 py-1.5 text-[0.6875rem] font-medium text-success transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => {
              if (resolving()) return;
              setResolving(true);
              const { mutation, toolName, toolId, callId } = props.item;
              const { sessionId, onClose } = props;
              void (async () => {
                await resolveApproval(sessionId, callId, "Approve");
                closeApprovalDiff(mutation, toolName, toolId);
                onClose?.();
              })();
            }}
          >
            Approve
          </button>
          <button
            type="button"
            disabled={resolving()}
            class="rounded-md border border-error-border bg-error-bg px-3 py-1.5 text-[0.6875rem] font-medium text-error transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => {
              if (resolving()) return;
              setResolving(true);
              const { mutation, toolName, toolId, callId } = props.item;
              const { sessionId, onClose } = props;
              void (async () => {
                await resolveApproval(sessionId, callId, "Reject");
                closeApprovalDiff(mutation, toolName, toolId);
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
