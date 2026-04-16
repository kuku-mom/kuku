import { Show, type JSX } from "solid-js";

import ScrollArea from "~/components/scroll_area";

import { toggleToolExpanded } from "../chat_store";
import type { ChatToolMessage } from "../types";
import { formatToolIdentity, getToolInfo } from "../tool_identity";
import {
  getToolPreview,
  getToolStatusLabel,
  getToolStatusTone,
  type ChatUiTone,
} from "../ui_state";

const TONE_DOT: Record<ChatUiTone, string> = {
  neutral: "bg-text-muted",
  accent: "bg-info animate-pulse",
  warning: "bg-warning",
  danger: "bg-error",
  success: "bg-success",
};

const TONE_LABEL: Record<ChatUiTone, string> = {
  neutral: "text-text-muted",
  accent: "text-info",
  warning: "text-warning",
  danger: "text-error",
  success: "text-success",
};

function ToolCallCard(props: { sessionId: string; item: ChatToolMessage }): JSX.Element {
  const statusLabel = () => getToolStatusLabel(props.item);
  const statusTone = () => getToolStatusTone(props.item);
  const toolIdentity = () => formatToolIdentity(props.item.toolId, props.item.toolName);
  const toolInfo = () => getToolInfo(props.item.toolId ?? props.item.toolName);
  const showIdentity = () => toolIdentity() !== toolInfo().label;

  return (
    <div class="rounded-xs border border-border bg-bg-secondary text-xs">
      <button
        type="button"
        class="flex w-full items-start justify-between gap-3 rounded-xs px-3 py-2.5 text-left transition-colors hover:bg-ghost-hover"
        onClick={() => toggleToolExpanded(props.sessionId, props.item.callId)}
      >
        <div class="flex min-w-0 items-center gap-2">
          {/* Status dot */}
          <span class={`inline-block size-2 shrink-0 rounded-full ${TONE_DOT[statusTone()]}`} />

          <div class="min-w-0">
            <span class="font-medium text-text-primary">{toolInfo().label}</span>
            <Show when={showIdentity()}>
              <p class="mt-0.5 truncate text-[0.625rem] text-text-muted">{toolIdentity()}</p>
            </Show>
            <p class="mt-0.5 truncate text-[0.6875rem] text-text-muted">
              {getToolPreview(props.item)}
            </p>
          </div>
        </div>

        <div class="flex shrink-0 items-center gap-2">
          <span class={`text-[0.6875rem] font-medium ${TONE_LABEL[statusTone()]}`}>
            {statusLabel()}
          </span>
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="text-text-muted transition-transform"
            classList={{
              "rotate-90": props.item.expanded,
            }}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </div>
      </button>

      <Show when={props.item.expanded}>
        <div class="space-y-2 border-t border-border px-3 py-2.5">
          {/* Arguments */}
          <div>
            <span class="mb-1 block text-[0.625rem] font-medium tracking-wider text-text-muted uppercase">
              Arguments
            </span>
            <ScrollArea
              axis="y"
              scrollbarAutoHide="leave"
              class="max-h-28 rounded-xs bg-bg-primary/70"
            >
              <pre class="p-2 text-[0.6875rem] wrap-break-word whitespace-pre-wrap text-text-secondary">
                {JSON.stringify(props.item.arguments, null, 2)}
              </pre>
            </ScrollArea>
          </div>

          {/* Output */}
          <Show when={props.item.output}>
            <div>
              <span class="mb-1 block text-[0.625rem] font-medium tracking-wider text-text-muted uppercase">
                Result
              </span>
              <ScrollArea
                axis="y"
                scrollbarAutoHide="leave"
                class="max-h-28 rounded-xs border border-border bg-bg-primary/70"
              >
                <pre class="p-2 text-[0.6875rem] wrap-break-word whitespace-pre-wrap text-text-secondary">
                  {props.item.output}
                </pre>
              </ScrollArea>
            </div>
          </Show>

          {/* Error */}
          <Show when={props.item.error}>
            <div class="rounded-xs border border-error-border bg-error-bg px-2.5 py-2 text-[0.6875rem] text-error">
              {props.item.error}
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

export { ToolCallCard };
