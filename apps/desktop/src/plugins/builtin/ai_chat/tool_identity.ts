import { currentLocale } from "~/i18n";

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
    description:
      "Creates a new markdown file in your vault at the path you or the assistant agree on.",
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
    description:
      "Renames a file or moves it to another folder so your links and tree stay consistent.",
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
    description:
      "Returns tags or front-matter metadata attached to notes for filtering and organization.",
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
    description:
      "Suggests new [[wikilinks]] the assistant thinks would strengthen your network of notes.",
  },
  find_related_notes: {
    label: "Find Related Notes",
    activeLabel: "Finding related notes",
    description:
      "Surfaces other notes that talk about the same ideas, for discovery and backlinking.",
  },
  find_orphan_notes: {
    label: "Find Unlinked Notes",
    activeLabel: "Finding unlinked notes",
    description: "Finds notes with no inbound links, so you can connect them or archive them.",
  },
  get_vault_stats: {
    label: "Get Vault Stats",
    activeLabel: "Reading stats",
    description:
      "High-level counts or summaries (e.g. how many files) to ground answers in your vault size.",
  },
  open_file: {
    label: "Open File",
    activeLabel: "Opening",
    description:
      "Tells the app to open a file in the editor so you can see what the assistant is talking about.",
  },
};

const KO_TOOL_DISPLAY_BY_KIND: Partial<
  Record<string, { label: string; activeLabel: string; description: string }>
> = {
  search_vault: {
    label: "노트 검색",
    activeLabel: "검색 중",
    description: "지식보관함에서 관련 노트를 찾아, 답변에 필요한 문맥을 정확히 가져와요.",
  },
  search_notes: {
    label: "노트 검색",
    activeLabel: "검색 중",
    description: "지식보관함에서 관련 노트를 찾아, 답변에 필요한 문맥을 정확히 가져와요.",
  },
  read_file: {
    label: "파일 읽기",
    activeLabel: "읽는 중",
    description: "노트 내용을 읽어 요약하거나 근거를 확인할 수 있게 도와줘요.",
  },
  create_file: {
    label: "파일 만들기",
    activeLabel: "생성 중",
    description: "원하는 경로에 새 마크다운 파일을 만들어요.",
  },
  edit_file: {
    label: "파일 수정",
    activeLabel: "수정 중",
    description: "기존 파일에 패치를 적용해 문장을 고치거나 내용을 업데이트해요.",
  },
  move_file: {
    label: "파일 이동",
    activeLabel: "이동 중",
    description: "파일 이름을 바꾸거나 폴더를 옮겨 구조를 정리해요.",
  },
  delete_file: {
    label: "파일 삭제",
    activeLabel: "삭제 중",
    description: "파일을 삭제해요. 필요한 경우 앱에서 한 번 더 확인해요.",
  },
  list_files: {
    label: "파일 목록",
    activeLabel: "불러오는 중",
    description: "폴더 안 파일 목록을 확인해 다음 작업 대상을 정해요.",
  },
  get_outline: {
    label: "개요 보기",
    activeLabel: "분석 중",
    description: "본문 전체 대신 제목 구조만 빠르게 확인해요.",
  },
  get_tags: {
    label: "태그 보기",
    activeLabel: "태그 확인 중",
    description: "노트의 태그/메타데이터를 읽어 분류와 필터링에 활용해요.",
  },
  find_links: {
    label: "링크 찾기",
    activeLabel: "링크 찾는 중",
    description: "노트 간 위키링크 연결 관계를 찾아 탐색을 도와줘요.",
  },
  suggest_links: {
    label: "링크 제안",
    activeLabel: "분석 중",
    description: "노트 연결성을 높일 수 있는 새 [[위키링크]]를 제안해요.",
  },
  find_related_notes: {
    label: "관련 노트 찾기",
    activeLabel: "관련 노트 찾는 중",
    description: "비슷한 주제를 다루는 노트를 찾아 연결 후보를 보여줘요.",
  },
  find_orphan_notes: {
    label: "미연결 노트 찾기",
    activeLabel: "미연결 노트 찾는 중",
    description: "유입 링크가 없는 노트를 찾아 연결하거나 정리할 수 있게 도와줘요.",
  },
  get_vault_stats: {
    label: "지식보관함 통계",
    activeLabel: "통계 확인 중",
    description: "노트 수 같은 전체 통계를 확인해 현재 상태를 빠르게 파악해요.",
  },
  open_file: {
    label: "파일 열기",
    activeLabel: "열는 중",
    description: "에디터에서 파일을 바로 열어 현재 맥락을 확인해요.",
  },
};

const FALLBACK_TOOL_INFO = {
  label: "" as const,
  activeLabel: "Running" as const,
  description:
    "A server-side capability the assistant can call when your message needs that action.",
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
  const locale = currentLocale();

  if (locale === "ko") {
    const koInfo = KO_TOOL_DISPLAY_BY_KIND[kind];
    if (koInfo) return koInfo;
  }

  return (
    TOOL_DISPLAY_BY_KIND[kind] ?? {
      label: locale === "ko" ? kind || "도구" : kind || toolIdOrName,
      activeLabel: locale === "ko" ? "실행 중" : FALLBACK_TOOL_INFO.activeLabel,
      description:
        locale === "ko"
          ? "요청을 처리하기 위해 어시스턴트가 호출하는 서버 도구예요."
          : FALLBACK_TOOL_INFO.description,
    }
  );
}

function formatToolIdentity(toolId?: string, toolName?: string): string {
  const resolved = toolId ?? canonicalToolId(toolName ?? "");
  return resolved || toolName || "";
}

export { canonicalToolId, formatToolIdentity, getToolInfo, getToolKind };
