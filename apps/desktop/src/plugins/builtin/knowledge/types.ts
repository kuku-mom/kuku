type KnowledgeErrorCode =
  | "INVALID_ARGUMENT"
  | "VALIDATION_FAILED"
  | "UNSAFE_PATH"
  | "ALREADY_EXISTS"
  | "NOT_PENDING"
  | "APPLY_IN_PROGRESS"
  | "APPLY_RECOVERY_REQUIRED"
  | "APPLY_FAILED"
  | "DOCUMENT_CHANGED"
  | "IO_ERROR";

interface KnowledgeError {
  code: KnowledgeErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

type KnowledgeCommandResult<T> = { ok: true; value: T } | { ok: false; error: KnowledgeError };

type ProposalDefaultSelection = "yes" | "none";

type DecisionOptionId = "yes" | "no" | "other";

interface SourceRange {
  start_line: number;
  end_line: number;
}

interface SourceRefInput {
  path: string;
  title?: string;
  section_path?: string[];
  range?: SourceRange;
  checksum?: string;
  captured_at?: string;
}

type SourceRef = SourceRefInput & {
  captured_at: string;
};

interface ProposedMemoryInput {
  suggested_id?: string;
  kind?: string;
  title: string;
  body: string;
  tags?: string[];
  source_refs?: SourceRefInput[];
  decision?: {
    question?: string;
    selected_option_id?: DecisionOptionId;
    other_text?: string;
  };
}

interface CreateDecisionDocumentRequest {
  title?: string;
  context?: string;
  source_refs?: SourceRefInput[];
  proposed_memories: ProposedMemoryInput[];
  default_selection?: ProposalDefaultSelection;
}

interface KnowledgeStatusResult {
  initialized: boolean;
  root_exists: boolean;
  memory_dir_exists: boolean;
  proposals_dir_exists: boolean;
  decisions_dir_exists: boolean;
  cache_dir_exists: boolean;
}

type KnowledgeInitResult = KnowledgeStatusResult & {
  created_dirs: string[];
};

interface CreateDecisionDocumentResult {
  doc_id: string;
  proposal_id: string;
  path: string;
  title: string;
  created: boolean;
  should_open: true;
}

interface ReadDecisionDocumentRequest {
  path: string;
}

interface ReadDecisionDocumentResult {
  doc_id: string;
  proposal_id: string;
  path: string;
  markdown: string;
  checksum: string;
  status: string;
}

interface ReadMemoryRequest {
  id: string;
}

interface MemoryItem {
  id: string;
  kind?: string;
  title: string;
  body: string;
  tags: string[];
  source_refs: SourceRef[];
  status: string;
  created_at: string;
  updated_at: string;
  proposal_id: string;
  decision_document: string;
}

interface ReadMemoryResult {
  memory: MemoryItem;
  path: string;
  markdown: string;
}

interface ApplyDecisionDocumentRequest {
  path: string;
  expected_checksum: string;
  source: "editor_document_apply";
  recover?: boolean;
}

type ApplyDecisionDocumentStatus = "applied" | "partially_applied" | "needs_revision";

interface ApplyDecisionDocumentResult {
  doc_id: string;
  path: string;
  status: ApplyDecisionDocumentStatus;
  committed_memory_paths: string[];
  rejected_decision_ids: string[];
  needs_revision_decision_ids: string[];
  recovered_from_journal: boolean;
  warnings: string[];
  journal_cleanup_required?: boolean;
  journal_path?: string;
}

interface SearchMemoryRequest {
  query: string;
  limit?: number;
  tags?: string[];
  kinds?: string[];
}

interface MemorySearchHit {
  id: string;
  path: string;
  title: string;
  kind?: string;
  snippet: string;
  tags: string[];
  source_refs: SourceRef[];
  score: number;
}

interface MemorySearchResult {
  hits: MemorySearchHit[];
  warnings: string[];
  skipped_paths: string[];
}

interface MemoryContextRequest {
  query: string;
  active_path?: string;
  limit?: number;
}

interface MemoryContextResult {
  query: string;
  memories: MemorySearchHit[];
  warnings: string[];
  skipped_paths: string[];
}

export type {
  ApplyDecisionDocumentRequest,
  ApplyDecisionDocumentResult,
  ApplyDecisionDocumentStatus,
  CreateDecisionDocumentRequest,
  CreateDecisionDocumentResult,
  DecisionOptionId,
  KnowledgeCommandResult,
  KnowledgeError,
  KnowledgeErrorCode,
  KnowledgeInitResult,
  KnowledgeStatusResult,
  MemoryItem,
  MemoryContextRequest,
  MemoryContextResult,
  MemorySearchHit,
  MemorySearchResult,
  ProposalDefaultSelection,
  ProposedMemoryInput,
  ReadDecisionDocumentRequest,
  ReadDecisionDocumentResult,
  ReadMemoryRequest,
  ReadMemoryResult,
  SearchMemoryRequest,
  SourceRange,
  SourceRef,
  SourceRefInput,
};
