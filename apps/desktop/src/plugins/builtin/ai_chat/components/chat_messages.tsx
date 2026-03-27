import { For, Show, createEffect, createMemo, type JSX } from "solid-js";
import { createStore } from "solid-js/store";

import { chatState, getActiveSession, sendMessage } from "../chat_store";
import { ChatWelcome } from "./chat_welcome";
import type { ChatApprovalMessage, ChatMessage, ChatToolMessage } from "../types";
import { ApprovalWidget } from "./approval_widget";
import { MarkdownMessage } from "./markdown_message";
import { ToolProgress } from "./tool_progress";

// ── Helpers ──

/**
 * Group consecutive tool messages into runs so we can render them
 * as a single compact ToolProgress block instead of individual cards.
 *
 * 2-pass approach:
 *  Pass 1 — build a callId → approval map from all messages.
 *  Pass 2 — group messages; when flushing a tool-run, attach the matching
 *            approval as `linkedApproval` and mark it so it is skipped as
 *            a standalone approval group.
 */
interface MessageGroup {
  kind: "text" | "tool-run" | "approval";
  messages: ChatMessage[];
  linkedApproval?: ChatApprovalMessage;
}

function groupMessages(messages: readonly ChatMessage[]): MessageGroup[] {
  // Pass 1: index all approvals by callId
  const approvalsByCallId = new Map<string, ChatApprovalMessage>();
  for (const msg of messages) {
    if (msg.kind === "approval") {
      approvalsByCallId.set(msg.callId, msg);
    }
  }

  const linkedCallIds = new Set<string>();
  const groups: MessageGroup[] = [];
  let currentToolRun: ChatToolMessage[] = [];

  const flushToolRun = () => {
    if (currentToolRun.length === 0) return;

    // Find the first approval that matches any tool in this run
    let linkedApproval: ChatApprovalMessage | undefined;
    for (const tool of currentToolRun) {
      const approval = approvalsByCallId.get(tool.callId);
      if (approval) {
        linkedApproval = approval;
        linkedCallIds.add(approval.callId);
        break;
      }
    }

    groups.push({ kind: "tool-run", messages: [...currentToolRun], linkedApproval });
    currentToolRun = [];
  };

  // Pass 2: group messages sequentially
  for (const msg of messages) {
    if (msg.kind === "tool") {
      currentToolRun.push(msg);
    } else {
      flushToolRun();

      if (msg.kind === "approval") {
        // Skip standalone rendering if already linked to a tool-run
        if (!linkedCallIds.has(msg.callId)) {
          groups.push({ kind: "approval", messages: [msg] });
        }
      } else {
        groups.push({ kind: "text", messages: [msg] });
      }
    }
  }

  flushToolRun();
  return groups;
}

// ── Sub-components ──

function TextBubble(props: {
  role: "user" | "assistant" | "system";
  content: string;
  streaming?: boolean;
}): JSX.Element {
  return (
    <div
      class="rounded-xs border px-3 py-1.5 text-sm/relaxed"
      classList={{
        "border-accent/20 bg-accent-dim text-text-primary": props.role === "user",
        "border-transparent bg-bg-secondary/30 text-text-primary": props.role === "assistant",
        "border-border bg-bg-secondary/50 text-text-muted italic": props.role === "system",
      }}
    >
      <Show
        when={props.content.length > 0}
        fallback={<span class="text-text-muted">{props.streaming ? <StreamingDots /> : "…"}</span>}
      >
        <Show when={props.role === "user"} fallback={<MarkdownMessage content={props.content} />}>
          <p class="whitespace-pre-wrap">{props.content}</p>
        </Show>
      </Show>
      {/* Streaming cursor */}
      <Show when={props.streaming && props.content.length > 0}>
        <span class="ml-0.5 inline-block h-3.5 w-0.5 animate-pulse bg-text-muted align-text-bottom" />
      </Show>
    </div>
  );
}

function StreamingDots(): JSX.Element {
  return (
    <span class="inline-flex items-center gap-3">
      <span class="inline-block size-1.5 animate-bounce-lg rounded-full bg-text-muted [animation-delay:0ms]" />
      <span class="inline-block size-1.5 animate-bounce-lg rounded-full bg-text-muted [animation-delay:150ms]" />
      <span class="inline-block size-1.5 animate-bounce-lg rounded-full bg-text-muted [animation-delay:300ms]" />
    </span>
  );
}

function LoadingIndicator(): JSX.Element {
  return (
    <div class="flex items-center justify-center py-3">
      <StreamingDots />
    </div>
  );
}

// ── Tool-run + linked approval ──

function ToolRunGroup(props: {
  tools: ChatToolMessage[];
  linkedApproval: ChatApprovalMessage | undefined;
  sessionId: string;
  showApproval: boolean;
  onToggle: () => void;
  onClose: () => void;
}): JSX.Element {
  const approval = () => props.linkedApproval;
  const visibleApproval = () => (props.showApproval ? approval() : undefined);

  return (
    <div class="flex flex-col gap-1">
      <ToolProgress tools={props.tools} linkedApproval={approval()} onHintClick={props.onToggle} />

      {/* ApprovalWidget — shown when toggled open */}
      <Show when={visibleApproval()}>
        {(a) => <ApprovalWidget sessionId={props.sessionId} item={a()} onClose={props.onClose} />}
      </Show>
    </div>
  );
}

// ── Main Component ──

function ChatMessages(): JSX.Element {
  const session = () => getActiveSession();
  const messages = () => session()?.messages ?? [];
  const groups = createMemo(() => groupMessages(messages()));

  // Approval open states keyed by callId — lifted here so ToolRunGroup
  // remounts (caused by groups() recomputation) don't reset the state.
  const [approvalOpen, setApprovalOpen] = createStore<Record<string, boolean>>({});

  // Auto-open only on first appearance of a pending approval.
  // Once a callId is recorded in approvalOpen (true OR false),
  // we never touch it again — so close/reopen is purely user-driven.
  createEffect(() => {
    for (const group of groups()) {
      const callId = group.linkedApproval?.callId;
      if (callId && group.linkedApproval?.status === "pending" && !(callId in approvalOpen)) {
        setApprovalOpen(callId, true);
      }
    }
  });

  const isStreaming = () => {
    const s = session();
    return s?.status === "streaming" || s?.status === "applying";
  };

  const hasMessages = () => messages().length > 0;
  const handleWelcomeSubmit = (prompt: string) => {
    void sendMessage(prompt);
  };

  return (
    <div class="flex min-h-full flex-1 flex-col p-3">
      <Show
        when={hasMessages()}
        fallback={<ChatWelcome mode={chatState.selectedMode} onSubmit={handleWelcomeSubmit} />}
      >
        <div class="flex flex-col gap-2.5">
          <For each={groups()}>
            {(group) => {
              // ── Tool run ──
              if (group.kind === "tool-run") {
                const callId = group.linkedApproval?.callId ?? "";
                return (
                  <ToolRunGroup
                    tools={group.messages as ChatToolMessage[]}
                    linkedApproval={group.linkedApproval}
                    sessionId={session()?.id ?? ""}
                    showApproval={callId ? (approvalOpen[callId] ?? false) : false}
                    onToggle={() => {
                      if (callId) setApprovalOpen(callId, (v) => !v);
                    }}
                    onClose={() => {
                      if (callId) setApprovalOpen(callId, false);
                    }}
                  />
                );
              }

              // ── Standalone approval (unlinked) ──
              if (group.kind === "approval") {
                const msg = group.messages[0];
                if (msg?.kind === "approval") {
                  return <ApprovalWidget sessionId={session()?.id ?? ""} item={msg} />;
                }
                return null;
              }

              // ── Text message ──
              const msg = group.messages[0];
              if (msg?.kind !== "text") return null;

              return <TextBubble role={msg.role} content={msg.content} streaming={msg.streaming} />;
            }}
          </For>

          {/* Loading indicator when streaming but no streaming text bubble yet */}
          <Show
            when={
              isStreaming() &&
              messages().length > 0 &&
              (() => {
                const last = messages()[messages().length - 1];
                return !(last?.kind === "text" && last.streaming);
              })()
            }
          >
            <LoadingIndicator />
          </Show>
        </div>
      </Show>
    </div>
  );
}

export { ChatMessages };
