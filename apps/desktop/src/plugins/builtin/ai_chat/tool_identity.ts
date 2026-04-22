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

/** Label, running label, and a one-line explanation for settings / help. */
const TOOL_DISPLAY_BY_KIND: Record<
  string,
  { label: string; activeLabel: string; description: string }
> = {
  search_vault: {
    label: "Search Notes",
    activeLabel: "Searching",
    description:
      "Searches your vault for note titles and content so the assistant can find the right passages to answer from.",
  },
  search_notes: {
    label: "Search Notes",
    activeLabel: "Searching",
    description:
      "Searches your vault for note titles and content so the assistant can find the right passages to answer from.",
  },
  read_file: {
    label: "Read File",
    activeLabel: "Reading",
    description:
      "Opens a note or file and returns its text so the model can quote, summarize, or reason about it.",
  },
  create_file: {
    label: "Create File",
    activeLabel: "Creating",
    description: "Creates a new markdown file in your vault at the path you or the assistant agree on.",
  },
  edit_file: {
    label: "Edit File",
    activeLabel: "Editing",
    description:
      "Applies a patch or replacement to an existing file—useful for rewrites, fixes, or filling in sections.",
  },
  move_file: {
    label: "Move File",
    activeLabel: "Moving",
    description: "Renames a file or moves it to another folder so your links and tree stay consistent.",
  },
  delete_file: {
    label: "Delete File",
    activeLabel: "Deleting",
    description:
      "Removes a file from the vault. The app may ask you to confirm before anything is deleted.",
  },
  list_files: {
    label: "List Files",
    activeLabel: "Listing",
    description:
      "Lists file names under a folder so the assistant can see what exists before reading or editing.",
  },
  get_outline: {
    label: "Get Outline",
    activeLabel: "Analyzing",
    description:
      "Reads a note’s headings only, for a quick map of structure without loading the whole body.",
  },
  get_tags: {
    label: "Get Tags",
    activeLabel: "Reading tags",
    description: "Returns tags or front-matter metadata attached to notes for filtering and organization.",
  },
  find_links: {
    label: "Find Links",
    activeLabel: "Finding links",
    description:
      "Finds wikilinks between notes—what points here, or what a note points to— for navigation and graph context.",
  },
  suggest_links: {
    label: "Suggest Links",
    activeLabel: "Analyzing",
    description: "Suggests new [[wikilinks]] the assistant thinks would strengthen your network of notes.",
  },
  find_related_notes: {
    label: "Find Related Notes",
    activeLabel: "Finding related notes",
    description:
      "Surfaces other notes that talk about the same ideas, for discovery and backlinking.",
  },
  find_orphan_notes: {
    label: "Find Orphan Notes",
    activeLabel: "Finding orphan notes",
    description:
      "Finds notes that nothing else links to, so you can connect or archive stragglers.",
  },
  get_vault_stats: {
    label: "Get Vault Stats",
    activeLabel: "Reading stats",
    description: "High-level counts or summaries (e.g. how many files) to ground answers in your vault size.",
  },
  open_file: {
    label: "Open File",
    activeLabel: "Opening",
    description: "Tells the app to open a file in the editor so you can see what the assistant is talking about.",
  },
};

const FALLBACK_TOOL_INFO = {
  label: "" as const,
  activeLabel: "Running" as const,
  description: "A server-side capability the assistant can call when your message needs that action.",
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
  return (
    TOOL_DISPLAY_BY_KIND[kind] ?? {
      label: kind || toolIdOrName,
      activeLabel: FALLBACK_TOOL_INFO.activeLabel,
      description: FALLBACK_TOOL_INFO.description,
    }
  );
}

function formatToolIdentity(toolId?: string, toolName?: string): string {
  const resolved = toolId ?? canonicalToolId(toolName ?? "");
  return resolved || toolName || "";
}

export { canonicalToolId, formatToolIdentity, getToolInfo, getToolKind };
