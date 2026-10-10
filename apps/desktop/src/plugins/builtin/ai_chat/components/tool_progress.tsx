import { For, Show, Switch, Match, type JSX } from "solid-js";
import { CheckIcon, CloseIcon } from "~/components/icons";

import type { ChatApprovalMessage, ChatToolMessage } from "../types";
import { getToolInfo, getToolKind } from "../tool_identity";

function getToolDetail(item: ChatToolMessage): string | null {
  const args = item.arguments;
  switch (getToolKind(item.toolId ?? item.toolName)) {
    case "search_vault":
    case "search_notes": {
      const query = typeof args.query === "string" ? args.query : null;
      return query ? `"${query}"` : null;
    }
    case "tasks_search": {
      return typeof args.query === "string" && args.query ? `"${args.query}"` : null;
    }
    case "task_create": {
      return typeof args.title === "string" ? args.title : null;
    }
    case "event_create": {
      const event = args.event;
      return event &&
        typeof event === "object" &&
        "title" in event &&
        typeof event.title === "string"
        ? event.title
        : null;
    }
    case "availability": {
      return typeof args.day === "string" ? args.day : null;
    }
    case "read_file":
    case "open_file":
    case "delete_file": {
      const path = typeof args.path === "string" ? args.path : null;
      if (!path) return null;
      return path.split("/").pop() ?? path;
    }
    case "create_file": {
      const path = typeof args.path === "string" ? args.path : null;
      return path ? (path.split("/").pop() ?? null) : null;
    }
    case "edit_file": {
      const path = typeof args.path === "string" ? args.path : null;
      if (!path) return null;
      return path.split("/").pop() ?? path;
    }
    default:
      return null;
  }
}

interface ToolProgressProps {
  tools: ChatToolMessage[];
  linkedApproval?: ChatApprovalMessage;
  onHintClick?: () => void;
}

function ToolProgress(props: ToolProgressProps): JSX.Element {
  return (
    <div class="my-0.5 w-full space-y-1 border-b border-border/35 bg-bg-secondary/20 px-0 py-2 text-xs">
      <For each={props.tools}>
        {(item) => {
          const info = getToolInfo(item.toolId ?? item.toolName);
          const isActive = !item.success && !item.error;
          const detail = getToolDetail(item);
          const isLinked = () =>
            props.linkedApproval !== undefined && props.linkedApproval.callId === item.callId;

          return (
            <div class="flex items-center gap-2 text-xs" classList={{ "animate-fade-in": true }}>
              {/* Status indicator */}
              <Switch>
                <Match when={isActive}>
                  <span class="inline-block size-2.5 shrink-0 animate-pulse rounded-full bg-info/30" />
                </Match>
                <Match when={item.success}>
                  <CheckIcon size={12} class="shrink-0 text-success/50" />
                </Match>
                <Match when={item.error}>
                  <CloseIcon size={12} class="shrink-0 text-error/80" />
                </Match>
              </Switch>

              {/* Label — underlined and clickable when linked to an approval */}
              <span
                classList={{
                  "text-text-secondary": isActive,
                  "text-text-muted": !isActive,
                  "cursor-pointer underline underline-offset-2": isLinked(),
                }}
                onClick={() => isLinked() && props.onHintClick?.()}
              >
                {isActive ? info.activeLabel : info.label}
              </span>

              {/* Detail */}
              <Show when={detail}>
                {(d) => <span class="truncate text-text-muted">{d()}</span>}
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}

export { ToolProgress };
