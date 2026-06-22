import type { JSX } from "solid-js";

import { MessageSquareIcon } from "~/components/icons";
import { t } from "~/i18n";
import type { FileEntry } from "~/lib/vault_fs";
import { sendMessage, switchMode, switchScope } from "~/plugins/builtin/ai_chat/chat_store";
import { folderHasMissingSetup } from "~/plugins/builtin/ai_chat/folder_scope";
import { openRightPanelView } from "~/stores/layout";

type FolderAgentAction = "ask" | "context" | "next" | "handoff" | "scaffold";

const ACTION_PROMPTS: Record<Exclude<FolderAgentAction, "ask">, { mode: "ask" | "agent"; prompt: string }> = {
  context: {
    mode: "ask",
    prompt: "Show folder context for this folder using project_context.",
  },
  next: {
    mode: "ask",
    prompt: "Show next steps for this folder using project_next_steps.",
  },
  handoff: {
    mode: "agent",
    prompt: "Create a Codex handoff proposal for this folder.",
  },
  scaffold: {
    mode: "agent",
    prompt: "Set up missing Folder Agent standard files for this folder with a proposal.",
  },
};

function runFolderAgentAction(entry: FileEntry, action: FolderAgentAction): void {
  switchScope({ kind: "folder", folder: entry.path });
  openRightPanelView("ai-chat.panel");
  if (action === "ask") return;

  const request = ACTION_PROMPTS[action];
  void (async () => {
    await switchMode(request.mode);
    await sendMessage(request.prompt, { includeSelectedText: false });
  })();
}

function FolderAgentRowAction(props: { entry: FileEntry }): JSX.Element {
  const needsSetup = () => folderHasMissingSetup(props.entry);
  return (
    <span class="ml-auto flex shrink-0 items-center gap-1 pr-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
      <span
        class="size-1.5 rounded-full"
        classList={{
          "bg-warning": needsSetup(),
          "bg-success/70": !needsSetup(),
        }}
        title={needsSetup() ? t("vault.folder_agent.needs_setup") : t("vault.folder_agent.ready")}
        aria-hidden="true"
      />
      <span
        role="button"
        tabIndex={0}
        class="grid size-5 place-items-center rounded-sm text-text-muted transition hover:bg-ghost-hover hover:text-text-primary"
        title={t("vault.folder_agent.ask")}
        onClick={(event) => {
          event.stopPropagation();
          runFolderAgentAction(props.entry, "ask");
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          runFolderAgentAction(props.entry, "ask");
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <MessageSquareIcon size={12} />
      </span>
    </span>
  );
}

export { FolderAgentRowAction, runFolderAgentAction };
export type { FolderAgentAction };
