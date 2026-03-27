import { For, Switch, Match, type JSX } from "solid-js";

import type { ChatToolMessage } from "../types";

const TOOL_DISPLAY: Record<string, { label: string; activeLabel: string }> = {
  search_notes: { label: "Search Notes", activeLabel: "Searching" },
  read_file: { label: "Read File", activeLabel: "Reading" },
  create_file: { label: "Create File", activeLabel: "Creating" },
  edit_file: { label: "Edit File", activeLabel: "Editing" },
  move_file: { label: "Move File", activeLabel: "Moving" },
  delete_file: { label: "Delete File", activeLabel: "Deleting" },
  list_files: { label: "List Files", activeLabel: "Listing" },
  get_outline: { label: "Get Outline", activeLabel: "Analyzing" },
  find_links: { label: "Find Links", activeLabel: "Finding links" },
  suggest_links: { label: "Suggest Links", activeLabel: "Analyzing" },
  open_file: { label: "Open File", activeLabel: "Opening" },
};

function getToolInfo(name: string): { label: string; activeLabel: string } {
  return TOOL_DISPLAY[name] ?? { label: name, activeLabel: "Running" };
}

function getToolDetail(item: ChatToolMessage): string | null {
  const args = item.arguments;
  switch (item.toolName) {
    case "search_notes": {
      const query = typeof args.query === "string" ? args.query : null;
      return query ? `"${query}"` : null;
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
}

function ToolProgress(props: ToolProgressProps): JSX.Element {
  return (
    <div class="my-1 max-w-fit space-y-0 px-1">
      <For each={props.tools}>
        {(item) => {
          const info = getToolInfo(item.toolName);
          const isActive = !item.success && !item.error;
          const detail = getToolDetail(item);

          return (
            <div
              class="flex items-center gap-2 pt-0.5 text-xs"
              classList={{
                "animate-fade-in": true,
              }}
            >
              {/* Status indicator */}
              <Switch>
                <Match when={isActive}>
                  <span class="inline-block size-2.5 shrink-0 animate-pulse rounded-full bg-info/30" />
                </Match>
                <Match when={item.success}>
                  <span class="shrink-0 text-[0.6875rem] text-success/50">✓</span>
                </Match>
                <Match when={item.error}>
                  <span class="shrink-0 text-[0.6875rem] text-error/80">✕</span>
                </Match>
              </Switch>

              {/* Label */}
              <span
                classList={{
                  "text-text-secondary": isActive,
                  "text-text-muted": !isActive,
                }}
              >
                {isActive ? info.activeLabel : info.label}
              </span>

              {/* Detail */}
              {detail && <span class="truncate text-text-muted">{detail}</span>}
            </div>
          );
        }}
      </For>
    </div>
  );
}

export { ToolProgress };
