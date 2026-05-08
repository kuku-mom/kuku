import { t, type MessageKey } from "~/i18n";

const BUILTIN_TOOL_ID_BY_NAME: Record<string, string> = {
  read_file: "builtin.read_file",
  list_files: "builtin.list_files",
  search_vault: "builtin.search_vault",
  create_file: "builtin.create_file",
  edit_file: "builtin.edit_file",
  delete_file: "builtin.delete_file",
  move_file: "builtin.move_file",
  get_outline: "builtin.get_outline",
  get_tags: "builtin.get_tags",
};

interface ToolInfoKeySet {
  label: MessageKey;
  activeLabel: MessageKey;
  description: MessageKey;
}

/** Label, running label, and a one-line explanation for settings / help. */
const TOOL_DISPLAY_KEYS_BY_KIND: Record<string, ToolInfoKeySet> = {
  search_vault: {
    label: "tool.search_notes.label",
    activeLabel: "tool.search_notes.active",
    description: "tool.search_notes.description",
  },
  search_notes: {
    label: "tool.search_notes.label",
    activeLabel: "tool.search_notes.active",
    description: "tool.search_notes.description",
  },
  read_file: {
    label: "tool.read_file.label",
    activeLabel: "tool.read_file.active",
    description: "tool.read_file.description",
  },
  create_file: {
    label: "tool.create_file.label",
    activeLabel: "tool.create_file.active",
    description: "tool.create_file.description",
  },
  edit_file: {
    label: "tool.edit_file.label",
    activeLabel: "tool.edit_file.active",
    description: "tool.edit_file.description",
  },
  move_file: {
    label: "tool.move_file.label",
    activeLabel: "tool.move_file.active",
    description: "tool.move_file.description",
  },
  delete_file: {
    label: "tool.delete_file.label",
    activeLabel: "tool.delete_file.active",
    description: "tool.delete_file.description",
  },
  list_files: {
    label: "tool.list_files.label",
    activeLabel: "tool.list_files.active",
    description: "tool.list_files.description",
  },
  get_outline: {
    label: "tool.get_outline.label",
    activeLabel: "tool.get_outline.active",
    description: "tool.get_outline.description",
  },
  get_tags: {
    label: "tool.get_tags.label",
    activeLabel: "tool.get_tags.active",
    description: "tool.get_tags.description",
  },
  find_links: {
    label: "tool.find_links.label",
    activeLabel: "tool.find_links.active",
    description: "tool.find_links.description",
  },
  suggest_links: {
    label: "tool.suggest_links.label",
    activeLabel: "tool.suggest_links.active",
    description: "tool.suggest_links.description",
  },
  find_related_notes: {
    label: "tool.find_related_notes.label",
    activeLabel: "tool.find_related_notes.active",
    description: "tool.find_related_notes.description",
  },
  find_orphan_notes: {
    label: "tool.find_orphan_notes.label",
    activeLabel: "tool.find_orphan_notes.active",
    description: "tool.find_orphan_notes.description",
  },
  get_vault_stats: {
    label: "tool.get_vault_stats.label",
    activeLabel: "tool.get_vault_stats.active",
    description: "tool.get_vault_stats.description",
  },
  open_file: {
    label: "tool.open_file.label",
    activeLabel: "tool.open_file.active",
    description: "tool.open_file.description",
  },
  wiki_search: {
    label: "tool.wiki_search.label",
    activeLabel: "tool.wiki_search.active",
    description: "tool.wiki_search.description",
  },
  wiki_read: {
    label: "tool.wiki_read.label",
    activeLabel: "tool.wiki_read.active",
    description: "tool.wiki_read.description",
  },
  knowledge_context: {
    label: "tool.knowledge_context.label",
    activeLabel: "tool.knowledge_context.active",
    description: "tool.knowledge_context.description",
  },
  wiki_propose_page: {
    label: "tool.wiki_propose_page.label",
    activeLabel: "tool.wiki_propose_page.active",
    description: "tool.wiki_propose_page.description",
  },
  wiki_propose_update: {
    label: "tool.wiki_propose_update.label",
    activeLabel: "tool.wiki_propose_update.active",
    description: "tool.wiki_propose_update.description",
  },
};

const FALLBACK_TOOL_INFO = {
  label: "" as const,
  activeLabel: "tool.fallback.active" as const,
  description: "tool.fallback.description" as const,
};

function canonicalToolId(toolName: string): string {
  if (toolName.includes(".")) return toolName;
  return BUILTIN_TOOL_ID_BY_NAME[toolName] ?? toolName;
}

function getToolKind(toolIdOrName: string | undefined | null): string {
  if (!toolIdOrName) return "";
  return canonicalToolId(toolIdOrName).split(".").at(-1) ?? toolIdOrName;
}

function getToolInfo(toolIdOrName: string): {
  label: string;
  activeLabel: string;
  description: string;
} {
  const kind = getToolKind(toolIdOrName);
  const infoKeys = TOOL_DISPLAY_KEYS_BY_KIND[kind];

  if (infoKeys) {
    return {
      label: t(infoKeys.label),
      activeLabel: t(infoKeys.activeLabel),
      description: t(infoKeys.description),
    };
  }

  return {
    label: kind || toolIdOrName || FALLBACK_TOOL_INFO.label,
    activeLabel: t(FALLBACK_TOOL_INFO.activeLabel),
    description: t(FALLBACK_TOOL_INFO.description),
  };
}

function formatToolIdentity(toolId?: string, toolName?: string): string {
  const resolved = toolId ?? canonicalToolId(toolName ?? "");
  return resolved || toolName || "";
}

export { canonicalToolId, formatToolIdentity, getToolInfo, getToolKind };
