import { For, Show, createEffect, createMemo, type JSX } from "solid-js";
import { createStore } from "solid-js/store";

import { chatState, getActiveSession, sendMessage, switchMode } from "../chat_store";
import { t } from "~/i18n";
import { ChatWelcome } from "./chat_welcome";
import type {
  ChatApprovalMessage,
  ChatMessage,
  ChatMessageAttachment,
  ChatMode,
  ChatToolMessage,
} from "../types";
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

function isUserTextGroup(g: MessageGroup): boolean {
  if (g.kind !== "text") return false;
  const m = g.messages[0];
  return m != null && m.kind === "text" && m.role === "user";
}

/**
 * Group flat message groups into "turns" (Cursor-style):
 * each turn starts with a user message; assistant/tools/approvals follow until the next user.
 */
function splitIntoTurns(chronological: readonly MessageGroup[]): MessageGroup[][] {
  const turns: MessageGroup[][] = [];
  let current: MessageGroup[] = [];

  for (const g of chronological) {
    if (isUserTextGroup(g) && current.length > 0) {
      turns.push(current);
      current = [g];
    } else {
      current.push(g);
    }
  }
  if (current.length > 0) {
    turns.push(current);
  }
  return turns;
}

// ── Sub-components ──

function FadeInlineDots(): JSX.Element {
  return (
    <span class="kuku-chat-fade-dots align-middle" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function ThinkingLine(): JSX.Element {
  return (
    <div class="flex w-full min-w-0 items-center" role="status" aria-label={t("chat.loading")}>
      <span class="kuku-chat-thinking-text shrink-0 text-[0.75rem]">{t("chat.thinking")}</span>
    </div>
  );
}

function TextBubble(props: {
  role: "user" | "assistant" | "system";
  content: string;
  attachments?: readonly ChatMessageAttachment[];
  streaming?: boolean;
}): JSX.Element {
  const attachments = () => props.attachments ?? [];

  if (props.role === "user") {
    return (
      <div class="mb-3 w-full min-w-0 text-[0.8125rem] leading-relaxed text-text-primary">
        <div class="w-full max-w-full rounded-sm border border-border/70 bg-bg-secondary/50 px-3 py-2.5">
          <Show when={attachments().length > 0}>
            <div class="mb-2 flex flex-wrap gap-1.5">
              <For each={attachments()}>
                {(attachment) => (
                  <span
                    class="inline-flex max-w-full items-center rounded-sm border border-border/50 bg-bg-primary/50 px-1.5 py-0.5 text-[0.65rem] text-text-secondary"
                    title={
                      attachment.kind === "file"
                        ? attachment.path
                        : (attachment.activeFile ?? t("chat.attachment.selected_text"))
                    }
                  >
                    <span class="truncate">
                      {attachment.kind === "file"
                        ? `@${attachment.name}`
                        : selectionAttachmentLabel(attachment.activeFile)}
                    </span>
                    <span class="ml-1 text-text-muted/80">
                      ({formatBytes(attachment.sizeBytes)})
                    </span>
                  </span>
                )}
              </For>
            </div>
          </Show>
          <Show
            when={props.content.length > 0}
            fallback={<span class="text-text-placeholder">…</span>}
          >
            <p class="w-full min-w-0 wrap-break-word whitespace-pre-wrap text-text-primary">
              {props.content}
            </p>
          </Show>
        </div>
      </div>
    );
  }

  if (props.role === "system") {
    return (
      <div class="mb-2 w-full min-w-0 rounded-sm border border-border/50 bg-bg-secondary/50 px-2 py-1.5 text-[0.75rem] text-text-muted italic">
        {props.content}
      </div>
    );
  }

  /* Assistant: plain text — no box, no role label (Cursor-like) */
  return (
    <div class="mb-3 w-full min-w-0 text-[0.8125rem] leading-relaxed text-text-primary">
      <Show
        when={props.content.length > 0}
        fallback={
          <span class="text-text-muted">
            {props.streaming ? <FadeInlineDots /> : <span class="text-text-placeholder">…</span>}
          </span>
        }
      >
        <MarkdownMessage content={props.content} />
        <Show when={props.streaming && props.content.length > 0}>
          <span class="ml-0.5 inline-block h-3.5 w-px bg-text-muted/60 align-text-bottom" />
        </Show>
      </Show>
    </div>
  );
}

function selectionAttachmentLabel(activeFile: string | null): string {
  if (!activeFile) return t("chat.attachment.selected_text");
  const name = activeFile.split("/").at(-1) ?? activeFile;
  return `${t("chat.attachment.selected_text")} (${name})`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

function LoadingIndicator(): JSX.Element {
  return (
    <div class="mb-3 w-full min-w-0 py-1">
      <ThinkingLine />
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
    <div class="flex min-w-0 flex-col gap-1">
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
  /**
   * Turns stack down in time order; within a turn: user, then follow-ups.
   * The latest turn (user-first) uses a two-part layout: user + thinking, then the rest.
   */
  const displayTurns = createMemo(() => {
    const turns = splitIntoTurns(groups());
    return turns.map((turn, turnIdx) => ({
      isNewest: turnIdx === turns.length - 1,
      items: turn.map((group, gIdx) => ({ group, gIdx })),
    }));
  });

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
  const handleWelcomeSubmit = (mode: ChatMode, prompt: string) => {
    void (async () => {
      await switchMode(mode);
      await sendMessage(prompt);
    })();
  };

  /** “Thinking” — after the latest user line, before the assistant is streaming. */
  const shouldShowThinkingAfterUser = () => {
    if (!isStreaming() || messages().length === 0) return false;
    const last = messages()[messages().length - 1];
    return !(last?.kind === "text" && last.streaming);
  };

  function renderMessageGroupItem(group: MessageGroup): JSX.Element {
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

    if (group.kind === "approval") {
      const msg = group.messages[0];
      if (msg?.kind === "approval") {
        return <ApprovalWidget sessionId={session()?.id ?? ""} item={msg} />;
      }
      return null;
    }

    const msg = group.messages[0];
    if (msg?.kind !== "text") return null;

    return (
      <TextBubble
        role={msg.role}
        content={msg.content}
        attachments={msg.attachments}
        streaming={msg.streaming}
      />
    );
  }

  return (
    <div class="flex min-h-full min-w-0 flex-col px-3 pt-4 pb-9">
      <Show
        when={hasMessages()}
        fallback={<ChatWelcome mode={chatState.selectedMode} onSubmit={handleWelcomeSubmit} />}
      >
        <div class="mx-auto flex w-full max-w-full min-w-0 flex-col">
          <div class="flex min-w-0 flex-col gap-6">
            <For each={displayTurns()}>
              {(row) => {
                const hasUserAnchor = () =>
                  row.isNewest && row.items[0] != null && isUserTextGroup(row.items[0].group);

                return (
                  <div class="flex min-w-0 flex-col">
                    <Show
                      when={hasUserAnchor()}
                      fallback={
                        <For each={row.items}>
                          {(item) => (
                            <div
                              class="flex min-w-0 flex-col"
                              data-kuku-latest-user={
                                row.isNewest && item.gIdx === 0 && isUserTextGroup(item.group)
                                  ? ""
                                  : undefined
                              }
                            >
                              {renderMessageGroupItem(item.group)}
                              <Show
                                when={
                                  row.isNewest &&
                                  item.gIdx === 0 &&
                                  isUserTextGroup(item.group) &&
                                  shouldShowThinkingAfterUser()
                                }
                              >
                                <LoadingIndicator />
                              </Show>
                            </div>
                          )}
                        </For>
                      }
                    >
                      {(() => {
                        const first = row.items[0];
                        const rest = row.items.slice(1);
                        return (
                          <div class="flex min-w-0 flex-col">
                            <div class="flex min-w-0 flex-col" data-kuku-latest-user="">
                              {renderMessageGroupItem(first.group)}
                            </div>
                            <Show when={shouldShowThinkingAfterUser()}>
                              <LoadingIndicator />
                            </Show>
                            <div class="flex w-full min-w-0 flex-col">
                              <For each={rest}>
                                {(item) => (
                                  <div class="flex min-w-0 flex-col">
                                    {renderMessageGroupItem(item.group)}
                                  </div>
                                )}
                              </For>
                            </div>
                          </div>
                        );
                      })()}
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}

export { ChatMessages };
