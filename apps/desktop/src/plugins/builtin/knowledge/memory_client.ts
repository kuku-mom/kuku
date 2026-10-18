import { invoke } from "@tauri-apps/api/core";

export interface ScopePolicy {
  auto_save: boolean;
  shared: boolean;
}
export interface MemoryPolicy {
  enabled: boolean;
  writes_enabled: boolean;
  cloud_enabled: boolean;
  scopes: Record<string, ScopePolicy>;
}
export interface SourceRef {
  path: string;
  origin?: string;
  title?: string;
  quote?: string;
  captured_at: string;
}
export interface ProjectRecord {
  task_id: string;
  goal: string;
  state: string;
  decisions: string[];
  open_questions: string[];
  next_actions: string[];
  experiences: {
    conditions: string;
    method: string;
    result: string;
    outcome: "success" | "failure" | "unverified";
  }[];
  occurred_at: string;
}
export interface SharedMemory {
  record?: ProjectRecord;
  id: string;
  scope: string;
  client: string;
  title: string;
  body: string;
  kind?: string;
  version: number;
  shared: boolean;
  status: string;
  source_refs: SourceRef[];
  updated_at: string;
  tags: string[];
  expires_at?: string;
  decision_document: string;
}
export interface MemoryChange {
  seq: number;
  client: string;
  before: SharedMemory | null;
  after: SharedMemory;
  created_at: string;
}
export interface MemoryStatus {
  extraction_jobs?: { id: string; state: string; updated_at: string; paths: string[] }[];
  policy: MemoryPolicy;
  connections: {
    id: string;
    client: string;
    scopes: string[];
    last_success?: string;
    last_read?: string;
    last_write?: string;
  }[];
  memories: SharedMemory[];
  history: MemoryChange[];
  outbox: { id: string; state: string }[];
  remote_url: string;
  web_url: string;
}
export function memoryAdmin<T>(method: string, params: unknown = {}): Promise<T> {
  return invoke<T>("memory_admin", { method, params });
}
export function rememberInput(
  memory: Pick<SharedMemory, "title" | "body" | "scope"> & Partial<SharedMemory>,
) {
  return {
    request_id: crypto.randomUUID(),
    scope: memory.scope,
    title: memory.title,
    body: memory.body,
    id: memory.id ?? null,
    expected_version: memory.id ? memory.version : null,
    kind: memory.kind ?? null,
    tags: memory.tags ?? [],
    source_refs: memory.source_refs ?? [],
    expires_at: memory.expires_at ?? null,
  };
}
