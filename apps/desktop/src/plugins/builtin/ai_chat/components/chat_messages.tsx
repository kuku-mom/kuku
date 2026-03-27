import { For, Show, createMemo, type JSX } from "solid-js";

import { chatState, getActiveSession, sendMessage } from "../chat_store";
import { ChatWelcome } from "./chat_welcome";
import type { ChatMessage, ChatToolMessage } from "../types";
import { ApprovalWidget } from "./approval_widget";
import { MarkdownMessage } from "./markdown_message";
import { ToolProgress } from "./tool_progress";

// ── Helpers ──

/**
 * Group consecutive tool messages into runs so we can render them
 * as a single compact ToolProgress block instead of individual cards.
 */
interface MessageGroup {
  kind: "text" | "tool-run" | "approval";
  messages: ChatMessage[];
}

function groupMessages(messages: readonly ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let currentToolRun: ChatToolMessage[] = [];

  const flushToolRun = () => {
    if (currentToolRun.length > 0) {
      groups.push({ kind: "tool-run", messages: [...currentToolRun] });
      currentToolRun = [];
    }
  };

  for (const msg of messages) {
    if (msg.kind === "tool") {
      currentToolRun.push(msg);
    } else {
      flushToolRun();
      groups.push({
        kind: msg.kind === "approval" ? "approval" : "text",
        messages: [msg],
      });
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
      class="max-w-[92%] rounded-md border px-3 py-1.5 text-sm/relaxed"
      classList={{
        "self-end border-accent/20 bg-accent-dim text-text-primary": props.role === "user",
        "self-start border-border bg-bg-secondary text-text-primary": props.role === "assistant",
        "self-start border-border bg-bg-secondary/50 text-text-muted italic":
          props.role === "system",
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

// ── Main Component ──

function ChatMessages(): JSX.Element {
  const session = () => getActiveSession();
  const messages = () => session()?.messages ?? [];
  const groups = createMemo(() => groupMessages(messages()));

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
              // ── Tool run: render as compact progress list ──
              if (group.kind === "tool-run") {
                const tools = group.messages as ChatToolMessage[];
                return <ToolProgress tools={tools} />;
              }

              // ── Approval widget ──
              if (group.kind === "approval") {
                const msg = group.messages[0];
                if (msg.kind === "approval") {
                  return <ApprovalWidget sessionId={session()?.id ?? ""} item={msg} />;
                }
                return null;
              }

              // ── Text message ──
              const msg = group.messages[0];
              if (msg.kind !== "text") return null;

              return <TextBubble role={msg.role} content={msg.content} streaming={msg.streaming} />;
            }}
          </For>

          {/* Loading indicator when streaming and the last message isn't already streaming */}
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
