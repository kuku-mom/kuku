import { invoke } from "@tauri-apps/api/core";
import { batch } from "solid-js";
import { createStore, produce } from "solid-js/store";

import { getCurrentVault } from "~/lib/vault_fs";

import { openApprovalDiff } from "./approval_diff";
import {
  AI_CHAT_SETTINGS_PLUGIN_ID,
  AI_CHAT_SECURE_KEYS,
  CODEX_ACP_AGENT_ID,
  DEFAULT_EXTERNAL_AGENTS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_PROXY_TIMEOUT_MS,
  DEFAULT_ROUND_LIMIT,
  DEFAULT_SERVER_URL,
  aiChatSecureKeysForConfig,
  aiChatSecureKeysForRawSettings,
  aiChatSecureKeysForSave,
  createDefaultAiConfig,
  hydrateAiConfigExternalSecrets,
  normalizeAiConfig,
  normalizeExternalAgentConfigList,
  prepareAiConfigForSave,
} from "./config";
import { createContextSnapshotSource } from "./context_snapshot";
import { appendFileAttachment, prepareEmbeddedFilesForSend } from "./file_embed";
import { hasRespondingSession } from "./responding_state";
import { prepareSelectedTextForSend } from "./selected_text_context";
import { BUILTIN_AGENT_CATALOG, KUKU_NATIVE_AGENT_ID } from "./agent_catalog";
import type {
  AiConfig,
  AgentDescriptor,
  AgentId,
  ChatApprovalMessage,
  ChatFileAttachmentDraft,
  ChatMessage,
  ChatMode,
  ChatSessionSummary,
  ChatSessionState,
  ChatStoreState,
  ChatTextMessage,
  ChatToolMessage,
  DonePayload,
  ErrorPayload,
  NewSessionPayload,
  PendingApprovalPayload,
  PersistedAgentSession,
  SendMessageOptions,
  ToolCallEndPayload,
  ToolCallStartPayload,
  ToolDescriptor,
} from "./types";
import type { ChatPermissionPresetId } from "./permission_presets";
import { setContextKey } from "~/plugins/context_keys";
import { loadPluginSettings, savePluginSettings } from "~/plugins/settings_store";

const BUSY_SESSION_STATUSES: ChatSessionState["status"][] = [
  "streaming",
  "awaiting-approval",
  "applying",
];
const CHAT_SESSIONS_STORAGE_KEY = "kuku.aiChat.sessions.v1";
const NO_VAULT_SESSION_SCOPE = "no-vault";

interface PersistedChatSessionSnapshot {
  id: string;
  externalSessionId?: string | null;
  agentId: AgentId;
  mode: ChatMode;
  createdAt: number;
  updatedAt: number;
  persistedTitle?: string;
  supportsLoad?: boolean;
  supportsResume?: boolean;
  workingDirectory?: string | null;
  draft: string;
  autoApprove: boolean;
  messages: ChatMessage[];
}

type RuntimeChatMessage =
  | { kind: "system"; content: string }
  | { kind: "user"; content: string }
  | { kind: "assistant"; content: string; toolCalls?: [] }
  | {
      kind: "toolResult";
      callId: string;
      toolName: string;
      output: string;
      isError: boolean;
};

let currentChatSessionVaultRoot: string | null = null;
const pendingLegacyHandoffBySessionId = new Map<string, string>();
let pendingPersistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPersistRequest:
  | {
      workingDirectory: string | null;
      sessions: PersistedChatSessionSnapshot[];
    }
  | null = null;
let activeLoadSessionsRequestId = 0;
const [chatState, setChatState] = createStore<ChatStoreState>({
  selectedAgentId: KUKU_NATIVE_AGENT_ID,
  agents: BUILTIN_AGENT_CATALOG,
  selectedMode: "ask",
  permissionPreset: "default",
  activeSessionId: null,
  sessionSummariesVersion: 0,
  sessions: {},
  isLoadingSessions: false,
  isCreatingSession: false,
  isSendingMessage: false,
  config: {
    apiKey: "",
    provider: DEFAULT_PROVIDER,
    serverUrl: DEFAULT_SERVER_URL,
    model: DEFAULT_MODEL,
    externalAgents: DEFAULT_EXTERNAL_AGENTS,
    rawConfig: {},
    loading: false,
    saving: false,
    error: null,
    toolsLoading: false,
    toolsError: null,
    availableTools: [],
  },
});
let lastResponding = false;
let lastSessionTimestamp = 0;

setContextKey("aiResponding", false);

function createDefaultConfigState(): ChatStoreState["config"] {
  return {
    apiKey: "",
    provider: DEFAULT_PROVIDER,
    serverUrl: DEFAULT_SERVER_URL,
    model: DEFAULT_MODEL,
    externalAgents: DEFAULT_EXTERNAL_AGENTS,
    rawConfig: {},
    loading: false,
    saving: false,
    error: null,
    toolsLoading: false,
    toolsError: null,
    availableTools: [],
  };
}

function getActiveSession(): ChatSessionState | null {
  const id = chatState.activeSessionId;
  if (!id) return null;
  return chatState.sessions[id] ?? null;
}

function syncRespondingState(): void {
  const responding = hasRespondingSession(chatState.sessions);
  if (responding === lastResponding) return;

  lastResponding = responding;
  setContextKey("aiResponding", responding);
}

function createSessionState(
  id: string,
  mode: ChatMode,
  agentId: AgentId = KUKU_NATIVE_AGENT_ID,
): ChatSessionState {
  const now = nextSessionTimestamp();
  return {
    id,
    agentId,
    mode,
    createdAt: now,
    updatedAt: now,
    workingDirectory: currentChatSessionVaultRoot,
    draft: "",
    fileAttachments: [],
    messages: [],
    inflightAssistantId: null,
    autoApprove: false,
    status: "idle",
    error: null,
    finishReason: null,
  };
}

function createPersistedSessionState(
  session: PersistedAgentSession,
  scopeRoot = currentChatSessionVaultRoot,
): ChatSessionState {
  return {
    ...createSessionState(session.localSessionId, "ask", session.agentId),
    externalSessionId: session.externalSessionId,
    persistedTitle: session.title,
    restored: true,
    supportsLoad: session.supportsLoad,
    supportsResume: session.supportsResume,
    workingDirectory: scopeRoot ?? normalizeChatSessionVaultRoot(session.workingDirectory),
    createdAt: session.updatedAtMs,
    updatedAt: session.updatedAtMs,
  };
}

function createStoredSessionState(
  snapshot: PersistedChatSessionSnapshot,
  session?: PersistedAgentSession,
  scopeRoot = currentChatSessionVaultRoot,
): ChatSessionState {
  const updatedAt = Math.max(snapshot.updatedAt, session?.updatedAtMs ?? 0);
  return {
    ...createSessionState(snapshot.id, snapshot.mode, snapshot.agentId),
    externalSessionId: session?.externalSessionId ?? snapshot.externalSessionId,
    persistedTitle: session?.title || snapshot.persistedTitle,
    restored: true,
    supportsLoad: session?.supportsLoad ?? snapshot.supportsLoad,
    supportsResume: session?.supportsResume ?? snapshot.supportsResume,
    workingDirectory:
      scopeRoot ??
      normalizeChatSessionVaultRoot(session?.workingDirectory ?? snapshot.workingDirectory) ??
      currentChatSessionVaultRoot,
    createdAt: snapshot.createdAt,
    updatedAt,
    draft: snapshot.draft,
    messages: snapshot.messages,
    autoApprove: snapshot.autoApprove,
  };
}

function getChatSessionStorage(): Storage | null {
  if (typeof localStorage === "undefined" || localStorage === null) return null;
  if (
    typeof localStorage.getItem !== "function" ||
    typeof localStorage.setItem !== "function" ||
    typeof localStorage.removeItem !== "function"
  ) {
    return null;
  }
  return localStorage;
}

function normalizeChatSessionVaultRoot(root: string | null | undefined): string | null {
  if (typeof root !== "string") return null;
  const normalized = normalizeVaultRootPath(root);
  return normalized || null;
}

function normalizeVaultRootPath(root: string): string {
  const normalized = root.trim().replace(/\\/g, "/");
  if (!normalized) return "";
  if (normalized === "/") return normalized;
  if (/^[A-Za-z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/g, "");
}

function setCurrentChatSessionVaultRoot(root: string | null | undefined): string | null {
  currentChatSessionVaultRoot = normalizeChatSessionVaultRoot(root);
  return currentChatSessionVaultRoot;
}

function chatSessionStorageKey(vaultRoot = currentChatSessionVaultRoot): string {
  return `${CHAT_SESSIONS_STORAGE_KEY}:${encodeURIComponent(vaultRoot ?? NO_VAULT_SESSION_SCOPE)}`;
}

function sessionMatchesVaultRoot(
  session: PersistedAgentSession,
  vaultRoot: string | null,
): boolean {
  return normalizeChatSessionVaultRoot(session.workingDirectory) === vaultRoot;
}

function snapshotMatchesVaultRoot(
  snapshot: PersistedChatSessionSnapshot,
  vaultRoot: string | null,
): boolean {
  return normalizeChatSessionVaultRoot(snapshot.workingDirectory) === vaultRoot;
}

function chatSessionMatchesCurrentVault(session: ChatSessionState): boolean {
  return normalizeChatSessionVaultRoot(session.workingDirectory) === currentChatSessionVaultRoot;
}

function scopedAgentSessions(
  sessions: PersistedAgentSession[],
  vaultRoot: string | null,
): PersistedAgentSession[] {
  const exactMatches = sessions.filter((session) => sessionMatchesVaultRoot(session, vaultRoot));
  if (vaultRoot === null) return exactMatches;
  return exactMatches.length > 0 ? exactMatches : sessions;
}

function scopedChatSessionSnapshots(
  snapshots: PersistedChatSessionSnapshot[],
  vaultRoot: string | null,
): PersistedChatSessionSnapshot[] {
  const exactMatches = snapshots.filter((snapshot) => snapshotMatchesVaultRoot(snapshot, vaultRoot));
  if (vaultRoot === null) return exactMatches;
  return exactMatches.length > 0 ? exactMatches : snapshots;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function isChatMode(value: unknown): value is ChatMode {
  return value === "ask" || value === "agent" || value === "inline";
}

function isStoredChatMessage(value: unknown): value is ChatMessage {
  const record = asRecord(value);
  if (!record || typeof record.id !== "string") return false;

  switch (record.kind) {
    case "text":
      return (
        (record.role === "user" || record.role === "assistant" || record.role === "system") &&
        typeof record.content === "string"
      );
    case "tool":
      return (
        typeof record.callId === "string" &&
        typeof record.toolName === "string" &&
        asRecord(record.arguments) != null
      );
    case "approval":
      return (
        typeof record.callId === "string" &&
        typeof record.toolName === "string" &&
        asRecord(record.mutation) != null &&
        (record.status === "pending" ||
          record.status === "approved" ||
          record.status === "rejected" ||
          record.status === "applied" ||
          record.status === "conflict" ||
          record.status === "error")
      );
    default:
      return false;
  }
}

function readLocalSessionSnapshots(
  vaultRoot = currentChatSessionVaultRoot,
): Map<string, PersistedChatSessionSnapshot> {
  const raw = getChatSessionStorage()?.getItem(chatSessionStorageKey(vaultRoot));
  if (!raw) return new Map();

  try {
    const parsed = asRecord(JSON.parse(raw));
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
      return new Map();
    }

    const snapshots = new Map<string, PersistedChatSessionSnapshot>();
    for (const value of parsed.sessions) {
      const session = asRecord(value);
      if (!session || typeof session.id !== "string" || typeof session.agentId !== "string") {
        continue;
      }

      snapshots.set(session.id, {
        id: session.id,
        externalSessionId:
          typeof session.externalSessionId === "string" || session.externalSessionId === null
            ? session.externalSessionId
            : undefined,
        agentId: session.agentId,
        mode: isChatMode(session.mode) ? session.mode : "ask",
        createdAt: typeof session.createdAt === "number" ? session.createdAt : 0,
        updatedAt: typeof session.updatedAt === "number" ? session.updatedAt : 0,
        persistedTitle:
          typeof session.persistedTitle === "string" ? session.persistedTitle : undefined,
        supportsLoad: typeof session.supportsLoad === "boolean" ? session.supportsLoad : undefined,
        supportsResume:
          typeof session.supportsResume === "boolean" ? session.supportsResume : undefined,
        workingDirectory:
          typeof session.workingDirectory === "string" || session.workingDirectory === null
            ? normalizeChatSessionVaultRoot(session.workingDirectory)
            : undefined,
        draft: typeof session.draft === "string" ? session.draft : "",
        autoApprove: session.autoApprove === true,
        messages: Array.isArray(session.messages)
          ? session.messages.filter(isStoredChatMessage)
          : [],
      });
    }

    return snapshots;
  } catch {
    return new Map();
  }
}

function normalizePersistedSessionSnapshot(
  value: unknown,
): PersistedChatSessionSnapshot | null {
  const session = asRecord(value);
  if (!session || typeof session.id !== "string" || typeof session.agentId !== "string") {
    return null;
  }

  return {
    id: session.id,
    externalSessionId:
      typeof session.externalSessionId === "string" || session.externalSessionId === null
        ? session.externalSessionId
        : undefined,
    agentId: session.agentId,
    mode: isChatMode(session.mode) ? session.mode : "ask",
    createdAt: typeof session.createdAt === "number" ? session.createdAt : 0,
    updatedAt: typeof session.updatedAt === "number" ? session.updatedAt : 0,
    persistedTitle:
      typeof session.persistedTitle === "string" ? session.persistedTitle : undefined,
    supportsLoad: typeof session.supportsLoad === "boolean" ? session.supportsLoad : undefined,
    supportsResume: typeof session.supportsResume === "boolean" ? session.supportsResume : undefined,
    workingDirectory:
      typeof session.workingDirectory === "string" || session.workingDirectory === null
        ? normalizeChatSessionVaultRoot(session.workingDirectory)
        : undefined,
    draft: typeof session.draft === "string" ? session.draft : "",
    autoApprove: session.autoApprove === true,
    messages: Array.isArray(session.messages) ? session.messages.filter(isStoredChatMessage) : [],
  };
}

async function readBackendSessionSnapshots(
  workingDirectory: string | null,
): Promise<Map<string, PersistedChatSessionSnapshot>> {
  try {
    const values = await invoke<PersistedChatSessionSnapshot[]>(
      "plugin:kuku-ai|ai_list_chat_sessions",
      workingDirectory ? { workingDirectory } : undefined,
    );
    const scopedValues = scopedChatSessionSnapshots(values, workingDirectory);
    const snapshots = new Map<string, PersistedChatSessionSnapshot>();
    for (const value of scopedValues) {
      const snapshot = normalizePersistedSessionSnapshot(value);
      if (!snapshot) continue;
      snapshots.set(snapshot.id, snapshot);
    }
    return snapshots;
  } catch {
    return new Map();
  }
}

function serializeChatMessageForStorage(message: ChatMessage): ChatMessage {
  switch (message.kind) {
    case "text":
      return {
        ...message,
        streaming: false,
      };
    case "tool":
      return {
        ...message,
        expanded: false,
      };
    case "approval":
      return {
        ...message,
        expanded: false,
        status: message.status === "pending" ? "error" : message.status,
        error:
          message.status === "pending"
            ? (message.error ?? "Pending approval was interrupted by app restart.")
            : message.error,
      };
  }
}

function serializeSessionForStorage(session: ChatSessionState): PersistedChatSessionSnapshot {
  return {
    id: session.id,
    externalSessionId: session.externalSessionId ?? null,
    agentId: session.agentId,
    mode: session.mode,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    persistedTitle: session.persistedTitle,
    supportsLoad: session.supportsLoad,
    supportsResume: session.supportsResume,
    workingDirectory: session.workingDirectory ?? currentChatSessionVaultRoot,
    draft: session.draft,
    autoApprove: session.autoApprove,
    messages: session.messages.map(serializeChatMessageForStorage),
  };
}

async function savePersistedChatSessionSnapshots(
  workingDirectory: string | null,
  sessions: PersistedChatSessionSnapshot[],
): Promise<void> {
  try {
    await invoke<void>("plugin:kuku-ai|ai_save_chat_sessions", {
      ...(workingDirectory ? { workingDirectory } : {}),
      sessions,
    });
  } catch {
    // Keep the in-memory chat usable even if persistence is temporarily unavailable.
  }
}

function persistChatSessions(): void {
  const sessions = Object.values(chatState.sessions)
    .filter(chatSessionMatchesCurrentVault)
    .map(serializeSessionForStorage)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  pendingPersistRequest = {
    workingDirectory: currentChatSessionVaultRoot,
    sessions,
  };
  if (pendingPersistTimer) {
    clearTimeout(pendingPersistTimer);
  }
  pendingPersistTimer = setTimeout(() => {
    const request = pendingPersistRequest;
    pendingPersistTimer = null;
    pendingPersistRequest = null;
    if (!request) return;
    void savePersistedChatSessionSnapshots(request.workingDirectory, request.sessions);
  }, 0);
}

function clearPendingChatSessionPersist(): void {
  if (pendingPersistTimer) {
    clearTimeout(pendingPersistTimer);
  }
  pendingPersistTimer = null;
  pendingPersistRequest = null;
}

function clearLocalSessionSnapshots(): void {
  try {
    const storage = getChatSessionStorage();
    if (!storage) return;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key === CHAT_SESSIONS_STORAGE_KEY || key?.startsWith(`${CHAT_SESSIONS_STORAGE_KEY}:`)) {
        keys.push(key);
      }
    }
    for (const key of keys) {
      storage.removeItem(key);
    }
  } catch {
    // Ignore storage failures during reset.
  }
}

function clearLocalSessionSnapshotsForVault(vaultRoot: string | null): void {
  try {
    const storage = getChatSessionStorage();
    if (!storage) return;
    storage.removeItem(chatSessionStorageKey(vaultRoot));
    if (vaultRoot === null) {
      storage.removeItem(CHAT_SESSIONS_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures during migration cleanup.
  }
}

function nextSessionTimestamp(): number {
  const now = Date.now();
  lastSessionTimestamp = Math.max(now, lastSessionTimestamp + 1);
  return lastSessionTimestamp;
}

function touchSession(sessionId: string): void {
  if (!chatState.sessions[sessionId]) return;
  setChatState("sessions", sessionId, "updatedAt", nextSessionTimestamp());
}

function isSessionBusy(session: ChatSessionState | null | undefined): boolean {
  return session != null && BUSY_SESSION_STATUSES.includes(session.status);
}

function setSelectedMode(mode: ChatMode): void {
  setChatState("selectedMode", mode);
}

function setPermissionPreset(preset: ChatPermissionPresetId): void {
  setChatState("permissionPreset", preset);
}

function setChatAgents(agents: AgentDescriptor[]): void {
  const mergedAgents = applyExternalAgentConfig(agents, chatState.config.externalAgents);
  const nextSelectedAgentId = mergedAgents.some(
    (agent) => agent.id === chatState.selectedAgentId && agent.enabled,
  )
    ? chatState.selectedAgentId
    : KUKU_NATIVE_AGENT_ID;
  const active = getActiveSession();

  setChatState("agents", mergedAgents);
  if (chatState.selectedAgentId !== nextSelectedAgentId) {
    setChatState("selectedAgentId", nextSelectedAgentId);
  }
  if (active && !isSessionBusy(active) && active.agentId !== nextSelectedAgentId) {
    setChatState("activeSessionId", null);
  }
}

function applyExternalAgentConfig(
  agents: AgentDescriptor[],
  configs: AiConfig["externalAgents"],
): AgentDescriptor[] {
  const configById = new Map(
    normalizeExternalAgentConfigList(configs).map((config) => [config.id, config]),
  );
  return agents.filter(isSupportedAgentDescriptor).map((agent) => {
    if (agent.kind !== "acp") return agent;
    const config = configById.get(agent.id);
    if (!config) return agent;
    return {
      ...agent,
      label: config.label || agent.label,
      enabled: agent.enabled && config.enabled,
    };
  });
}

function isSupportedAgentDescriptor(agent: AgentDescriptor): boolean {
  return agent.kind === "native"
    ? agent.id === KUKU_NATIVE_AGENT_ID
    : agent.id === CODEX_ACP_AGENT_ID;
}

function setSelectedAgent(agentId: AgentId): boolean {
  const agent = chatState.agents.find((candidate) => candidate.id === agentId);
  if (!agent?.enabled) return false;

  if (agent.id === chatState.selectedAgentId) return true;

  const active = getActiveSession();
  setChatState("selectedAgentId", agent.id);
  if (active && !isSessionBusy(active) && active.agentId !== agent.id) {
    setChatState("activeSessionId", null);
  }
  return true;
}

function resetChatState(): void {
  setChatState({
    selectedAgentId: KUKU_NATIVE_AGENT_ID,
    agents: BUILTIN_AGENT_CATALOG,
    selectedMode: "ask",
    permissionPreset: "default",
    activeSessionId: null,
    sessionSummariesVersion: 0,
    sessions: {},
    isLoadingSessions: false,
    isCreatingSession: false,
    isSendingMessage: false,
    config: createDefaultConfigState(),
  });
  lastResponding = false;
  lastSessionTimestamp = 0;
  activeLoadSessionsRequestId = 0;
  currentChatSessionVaultRoot = null;
  pendingLegacyHandoffBySessionId.clear();
  clearPendingChatSessionPersist();
  setContextKey("aiResponding", false);
  clearLocalSessionSnapshots();
}

function setDraft(value: string): void {
  const session = getActiveSession();
  if (!session) return;
  setChatState("sessions", session.id, "draft", value);
  touchSession(session.id);
  persistChatSessions();
}

async function addFileAttachment(attachment: ChatFileAttachmentDraft): Promise<boolean> {
  const sessionId = await ensureSession();
  if (!sessionId) return false;

  const session = chatState.sessions[sessionId];
  if (!session) return false;

  try {
    const next = appendFileAttachment(session.fileAttachments, attachment);
    setChatState("sessions", sessionId, "fileAttachments", next);
    setChatState("sessions", sessionId, "error", null);
    touchSession(sessionId);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setChatState("sessions", sessionId, "error", message);
    appendSystemMessage(sessionId, message);
    return false;
  }
}

function removeFileAttachment(path: string): void {
  const session = getActiveSession();
  if (!session) return;
  setChatState("sessions", session.id, "fileAttachments", (current) =>
    current.filter((attachment) => attachment.path !== path),
  );
  touchSession(session.id);
}

function clearFileAttachments(sessionId: string): void {
  if (!chatState.sessions[sessionId]) return;
  setChatState("sessions", sessionId, "fileAttachments", []);
}

function setSessionStatus(sessionId: string, status: ChatSessionState["status"]): void {
  if (chatState.sessions[sessionId]) {
    setChatState("sessions", sessionId, "status", status);
    if (
      chatState.activeSessionId === sessionId &&
      !BUSY_SESSION_STATUSES.includes(status) &&
      chatState.sessions[sessionId]?.agentId !== chatState.selectedAgentId
    ) {
      setChatState("activeSessionId", null);
    }
    syncRespondingState();
  }
}

function bumpSessionSummariesVersion(): void {
  setChatState("sessionSummariesVersion", (version) => version + 1);
}

function appendTextMessage(
  sessionId: string,
  message: Omit<Extract<ChatMessage, { kind: "text" }>, "id">,
): void {
  if (!chatState.sessions[sessionId]) return;
  const nextMessage: ChatTextMessage = { id: crypto.randomUUID(), ...message };
  setChatState("sessions", sessionId, "messages", (prev) => [...prev, nextMessage]);
  touchSession(sessionId);
  persistChatSessions();
}

function appendSystemMessage(sessionId: string, content: string): void {
  appendTextMessage(sessionId, {
    kind: "text",
    role: "system",
    content,
  });
}

function appendSystemMessageOnce(sessionId: string, content: string): void {
  const session = chatState.sessions[sessionId];
  const lastMessage = session?.messages.at(-1);
  if (
    lastMessage?.kind === "text" &&
    lastMessage.role === "system" &&
    lastMessage.content === content
  ) {
    return;
  }
  appendSystemMessage(sessionId, content);
}

function runtimeMessagesFromChatMessages(messages: ChatMessage[]): RuntimeChatMessage[] {
  return messages.flatMap((message): RuntimeChatMessage[] => {
    if (message.kind === "text") {
      switch (message.role) {
        case "system":
          return [{ kind: "system", content: message.content }];
        case "user":
          return [{ kind: "user", content: message.content }];
        case "assistant":
          return [{ kind: "assistant", content: message.content, toolCalls: [] }];
      }
    }

    if (message.kind === "tool") {
      const output = message.output ?? message.error;
      if (output == null) return [];
      return [
        {
          kind: "toolResult",
          callId: message.callId,
          toolName: message.toolName,
          output,
          isError: message.success === false || message.error != null,
        },
      ];
    }

    return [];
  });
}

function upsertAssistantPlaceholder(sessionId: string): string | null {
  const session = chatState.sessions[sessionId];
  if (!session) return null;

  if (session.inflightAssistantId) {
    return session.inflightAssistantId;
  }

  const id = crypto.randomUUID();
  const assistantMessage: ChatTextMessage = {
    id,
    kind: "text",
    role: "assistant",
    content: "",
    streaming: true,
  };
  batch(() => {
    setChatState("sessions", sessionId, "messages", (prev) => [...prev, assistantMessage]);
    setChatState("sessions", sessionId, "inflightAssistantId", id);
    touchSession(sessionId);
    setSessionStatus(sessionId, "streaming");
  });
  return id;
}

function closeAssistantSegment(sessionId: string): void {
  const session = chatState.sessions[sessionId];
  if (!session) return;

  const assistantId = session.inflightAssistantId;
  if (!assistantId) return;

  const index = session.messages.findIndex((message) => message.id === assistantId);
  if (index === -1) {
    setChatState("sessions", sessionId, "inflightAssistantId", null);
    return;
  }

  batch(() => {
    const current = session.messages[index];
    if (current.kind === "text") {
      setChatState("sessions", sessionId, "messages", index, {
        ...current,
        streaming: false,
      });
    }
    setChatState("sessions", sessionId, "inflightAssistantId", null);
  });
}

function appendDelta(sessionId: string, delta: string): void {
  const session = chatState.sessions[sessionId];
  if (!session) return;

  // Streaming hot path — each token fires `appendDelta`. Without `batch`
  // the message-append and status-flip run as separate reactive passes
  // on WebKit, which shows up as jittery incremental rendering.
  batch(() => {
    const id = upsertAssistantPlaceholder(sessionId);
    if (!id) return;

    const index = session.messages.findIndex((message) => message.id === id);
    if (index === -1) return;

    const current = session.messages[index];
    if (current.kind !== "text") return;

    setChatState("sessions", sessionId, "messages", index, {
      ...current,
      content: `${current.content}${delta}`,
      streaming: true,
    });
    touchSession(sessionId);
    setSessionStatus(sessionId, "streaming");
  });
}

function finishSession(sessionId: string, payload: DonePayload): void {
  const session = chatState.sessions[sessionId];
  if (!session) return;

  batch(() => {
    closeAssistantSegment(sessionId);
    setChatState("sessions", sessionId, "finishReason", payload.finishReason);
    if (payload.finishReason === "error") {
      setSessionStatus(sessionId, "error");
      return;
    }

    setSessionStatus(sessionId, "idle");
    setChatState("sessions", sessionId, "error", null);
  });
  persistChatSessions();
}

function setError(sessionId: string, payload: ErrorPayload): void {
  const session = chatState.sessions[sessionId];
  if (!session) return;

  closeAssistantSegment(sessionId);
  setSessionStatus(sessionId, "error");
  setChatState("sessions", sessionId, "error", payload.message);
  appendSystemMessageOnce(sessionId, payload.message);
}

function startToolCall(payload: ToolCallStartPayload): void {
  const session = chatState.sessions[payload.sessionId];
  if (!session) return;

  closeAssistantSegment(payload.sessionId);

  const existingIndex = session.messages.findIndex(
    (message): message is ChatToolMessage =>
      message.kind === "tool" && message.callId === payload.callId,
  );
  const existingMessage =
    existingIndex !== -1 && session.messages[existingIndex]?.kind === "tool"
      ? session.messages[existingIndex]
      : null;
  const toolMessage: ChatToolMessage = {
    id: existingMessage?.id ?? crypto.randomUUID(),
    kind: "tool",
    callId: payload.callId,
    toolName: payload.toolName,
    toolId: payload.toolId ?? existingMessage?.toolId,
    arguments: payload.arguments,
    expanded: existingMessage?.expanded ?? false,
  };

  if (existingIndex !== -1) {
    setChatState("sessions", payload.sessionId, "messages", existingIndex, toolMessage);
    persistChatSessions();
    return;
  }

  setChatState("sessions", payload.sessionId, "messages", (prev) => [...prev, toolMessage]);
  touchSession(payload.sessionId);
  persistChatSessions();
}

function endToolCall(payload: ToolCallEndPayload): void {
  const session = chatState.sessions[payload.sessionId];
  if (!session) return;

  const index = session.messages.findIndex(
    (message): message is ChatToolMessage =>
      message.kind === "tool" && message.callId === payload.callId,
  );
  if (index === -1) return;

  const current = session.messages[index];
  if (current.kind !== "tool") return;
  setChatState("sessions", payload.sessionId, "messages", index, {
    ...current,
    toolId: payload.toolId ?? current.toolId,
    success: !payload.isError,
    output: payload.isError ? undefined : payload.output,
    error: payload.isError ? payload.output : undefined,
  });
  touchSession(payload.sessionId);
  persistChatSessions();

  const approvalIndex = session.messages.findIndex(
    (message): message is ChatApprovalMessage =>
      message.kind === "approval" && message.callId === payload.callId,
  );
  if (approvalIndex === -1) return;

  const approval = session.messages[approvalIndex];
  if (approval.kind !== "approval") return;

  let status: ChatApprovalMessage["status"];
  let error: string | undefined;

  if (!payload.isError) {
    status = "applied";
  } else if (payload.output === "Rejected by user") {
    status = "rejected";
  } else if (payload.output.startsWith("Conflict:")) {
    status = "conflict";
    error = payload.output;
  } else {
    status = "error";
    error = payload.output;
  }

  setChatState("sessions", payload.sessionId, "messages", approvalIndex, {
    ...approval,
    status,
    expanded: false,
    error,
  });
  persistChatSessions();
}

function addPendingApproval(payload: PendingApprovalPayload): boolean {
  const session = chatState.sessions[payload.sessionId];
  if (!session) return false;

  const existingIndex = session.messages.findIndex(
    (message): message is ChatApprovalMessage =>
      message.kind === "approval" && message.callId === payload.callId,
  );
  const existingMessage =
    existingIndex !== -1 && session.messages[existingIndex]?.kind === "approval"
      ? session.messages[existingIndex]
      : null;

  const autoApprove = session.autoApprove;
  const approvalMessage: ChatApprovalMessage = {
    id: existingMessage?.id ?? crypto.randomUUID(),
    kind: "approval",
    callId: payload.callId,
    toolName: payload.toolName,
    toolId: payload.toolId ?? existingMessage?.toolId,
    mutation: payload.mutation,
    previewText: payload.previewText,
    expanded: !autoApprove,
    status: autoApprove ? "approved" : "pending",
  };

  if (existingIndex !== -1) {
    setChatState("sessions", payload.sessionId, "messages", existingIndex, approvalMessage);
  } else {
    setChatState("sessions", payload.sessionId, "messages", (prev) => [...prev, approvalMessage]);
  }
  touchSession(payload.sessionId);
  persistChatSessions();

  if (autoApprove) {
    setSessionStatus(payload.sessionId, "applying");
    void resolveApproval(payload.sessionId, payload.callId, "Approve");
    return true;
  }

  void openApprovalDiff(payload.mutation, payload.toolName, payload.toolId);
  setSessionStatus(payload.sessionId, "awaiting-approval");
  return false;
}

function updateApprovalStatus(
  sessionId: string,
  callId: string,
  status: ChatApprovalMessage["status"],
  error?: string,
): void {
  const session = chatState.sessions[sessionId];
  if (!session) return;

  const index = session.messages.findIndex(
    (message): message is ChatApprovalMessage =>
      message.kind === "approval" && message.callId === callId,
  );
  if (index === -1) return;

  const current = session.messages[index];
  if (current.kind !== "approval") return;
  setChatState("sessions", sessionId, "messages", index, {
    ...current,
    status,
    expanded: status === "pending" ? current.expanded : false,
    error,
  });
  persistChatSessions();
}

function toggleToolExpanded(sessionId: string, callId: string): void {
  const session = chatState.sessions[sessionId];
  if (!session || chatState.activeSessionId !== sessionId) return;

  const index = session.messages.findIndex(
    (message): message is ChatToolMessage => message.kind === "tool" && message.callId === callId,
  );
  if (index === -1) return;

  const current = session.messages[index];
  if (current.kind !== "tool") return;
  setChatState("sessions", sessionId, "messages", index, {
    ...current,
    expanded: !current.expanded,
  });
  persistChatSessions();
}

function toggleApprovalExpanded(sessionId: string, callId: string): void {
  const session = chatState.sessions[sessionId];
  if (!session || chatState.activeSessionId !== sessionId) return;

  const index = session.messages.findIndex(
    (message): message is ChatApprovalMessage =>
      message.kind === "approval" && message.callId === callId,
  );
  if (index === -1) return;

  const current = session.messages[index];
  if (current.kind !== "approval" || current.status === "pending") return;
  setChatState("sessions", sessionId, "messages", index, {
    ...current,
    expanded: !current.expanded,
  });
  persistChatSessions();
}

function setAutoApprove(sessionId: string, enabled: boolean): void {
  const session = chatState.sessions[sessionId];
  if (!session || chatState.activeSessionId !== sessionId) return;

  setChatState("sessions", sessionId, "autoApprove", enabled);
  touchSession(sessionId);
  persistChatSessions();
  if (!enabled) return;

  const pendingApprovals = session.messages.filter(
    (message): message is ChatApprovalMessage =>
      message.kind === "approval" && message.status === "pending",
  );

  for (const approval of pendingApprovals) {
    void resolveApproval(sessionId, approval.callId, "Approve");
  }
}

function resetToSession(
  sessionId: string,
  mode: ChatMode,
  agentId: AgentId = chatState.selectedAgentId,
): void {
  const current = chatState.sessions[sessionId];
  if (!current) {
    setChatState("sessions", sessionId, createSessionState(sessionId, mode, agentId));
    bumpSessionSummariesVersion();
  } else {
    setChatState("sessions", sessionId, "mode", mode);
    touchSession(sessionId);
  }
  setChatState("activeSessionId", sessionId);
  setChatState("selectedMode", mode);
  setChatState("selectedAgentId", chatState.sessions[sessionId]?.agentId ?? agentId);
  persistChatSessions();
}

function sessionTitle(session: ChatSessionState): string {
  const firstUserMessage = session.messages.find(
    (message): message is ChatTextMessage => message.kind === "text" && message.role === "user",
  );
  const title = firstUserMessage?.content.trim();
  if (title) {
    return title.length > 64 ? `${title.slice(0, 61)}...` : title;
  }

  if (session.persistedTitle?.trim()) {
    return session.persistedTitle.length > 64
      ? `${session.persistedTitle.slice(0, 61)}...`
      : session.persistedTitle;
  }

  switch (session.mode) {
    case "agent":
      return "Agent session";
    case "inline":
      return "Inline session";
    case "ask":
      return "Ask session";
  }
}

function getSessionSummaries(): ChatSessionSummary[] {
  void chatState.sessionSummariesVersion;
  const activeSessionId = chatState.activeSessionId;
  const vaultRoot = currentChatSessionVaultRoot;
  return Object.values(chatState.sessions)
    .filter((session) => normalizeChatSessionVaultRoot(session.workingDirectory) === vaultRoot)
    .map((session) => ({
      id: session.id,
      agentId: session.agentId,
      mode: session.mode,
      title: sessionTitle(session),
      draft: session.draft,
      messageCount: session.messages.length,
      status: session.status,
      isActive: activeSessionId === session.id,
      updatedAt: session.updatedAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function switchSession(sessionId: string): boolean {
  const session = chatState.sessions[sessionId];
  if (!session) return false;

  setChatState("activeSessionId", session.id);
  setChatState("selectedMode", session.mode);
  setChatState("selectedAgentId", session.agentId);
  touchSession(session.id);
  persistChatSessions();
  return true;
}

async function createSession(
  mode: ChatMode = chatState.selectedMode,
  agentId: AgentId = chatState.selectedAgentId,
): Promise<string | null> {
  const active = getActiveSession();
  if (isSessionBusy(active)) {
    return active?.id ?? null;
  }

  setChatState("isCreatingSession", true);
  try {
    const workingDirectory = setCurrentChatSessionVaultRoot(await getCurrentVault());
    const payload = await invoke<NewSessionPayload>("plugin:kuku-ai|ai_new_session", {
      agentId,
      mode,
      ...(workingDirectory ? { workingDirectory } : {}),
    });
    resetToSession(payload.sessionId, mode, agentId);
    return payload.sessionId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const currentSession = getActiveSession();
    if (currentSession) {
      setError(currentSession.id, { sessionId: currentSession.id, message });
    }
    return null;
  } finally {
    setChatState("isCreatingSession", false);
  }
}

async function closeSession(
  sessionId: string | null = chatState.activeSessionId,
): Promise<boolean> {
  if (!sessionId) return false;
  const session = chatState.sessions[sessionId];
  if (!session || isSessionBusy(session)) return false;
  const closedSessionId = sessionId;

  try {
    await invoke<void>("plugin:kuku-ai|ai_close_session", {
      agentId: session.agentId,
      sessionId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setError(sessionId, { sessionId, message });
    return false;
  }

  const replacementId =
    getSessionSummaries().find((summary) => summary.id !== sessionId)?.id ?? null;

  batch(() => {
    setChatState(
      "sessions",
      produce((sessions) => {
        delete sessions[closedSessionId];
      }),
    );
    bumpSessionSummariesVersion();
    setChatState("activeSessionId", replacementId);
    if (replacementId) {
      const replacement = chatState.sessions[replacementId];
      if (replacement) {
        setChatState("selectedMode", replacement.mode);
        setChatState("selectedAgentId", replacement.agentId);
      }
    }
  });
  persistChatSessions();

  return true;
}

async function ensureSession(): Promise<string | null> {
  const active = getActiveSession();
  const mode = chatState.selectedMode;
  if (active) {
    if (active.mode !== mode) {
      setChatState("sessions", active.id, "mode", mode);
    }
    if (active.restored) {
      if (!canRestoreSession(active)) {
        return createContinuationSession(active, mode);
      }
      return restoreSession(active.id);
    }
    return active.id;
  }
  return createSession(mode);
}

async function createContinuationSession(
  previousSession: ChatSessionState,
  mode: ChatMode,
): Promise<string | null> {
  const handoffPrompt = buildLegacyAcpHandoffPrompt(previousSession);
  const previousMessages = previousSession.messages.map((message) => ({ ...message }));
  const sessionId = await createSession(mode);
  if (!sessionId) return null;

  batch(() => {
    setChatState("sessions", sessionId, "messages", previousMessages);
    setChatState("sessions", sessionId, "draft", previousSession.draft);
    setChatState("sessions", sessionId, "autoApprove", previousSession.autoApprove);
  });
  if (handoffPrompt) {
    pendingLegacyHandoffBySessionId.set(sessionId, handoffPrompt);
  }
  persistChatSessions();
  return sessionId;
}

function canRestoreSession(session: ChatSessionState): boolean {
  if (session.agentId === KUKU_NATIVE_AGENT_ID) {
    return true;
  }
  return typeof session.externalSessionId === "string" && session.externalSessionId.trim() !== "";
}

function buildLegacyAcpHandoffPrompt(session: ChatSessionState): string | null {
  const transcript = session.messages
    .flatMap((message) => {
      if (message.kind !== "text") return [];
      const content = message.content.trim();
      if (!content) return [];
      return `${message.role.toUpperCase()}: ${content}`;
    })
    .join("\n\n")
    .trim();
  if (!transcript) return null;

  const maxLength = 12_000;
  const clippedTranscript =
    transcript.length > maxLength ? transcript.slice(transcript.length - maxLength) : transcript;

  return [
    "You are continuing a Kuku chat whose external ACP session could not be reattached.",
    "Use the prior local transcript below as conversation context. Do not mention this handoff unless the user asks.",
    "",
    "<previous_transcript>",
    clippedTranscript,
    "</previous_transcript>",
  ].join("\n");
}

async function restoreSession(sessionId: string): Promise<string | null> {
  const session = chatState.sessions[sessionId];
  if (!session) return null;

  setChatState("isCreatingSession", true);
  try {
    const workingDirectory = setCurrentChatSessionVaultRoot(await getCurrentVault());
    await invoke<NewSessionPayload>("plugin:kuku-ai|ai_restore_session", {
      agentId: session.agentId,
      sessionId,
      externalSessionId: session.externalSessionId ?? null,
      mode: session.mode,
      messages: runtimeMessagesFromChatMessages(session.messages),
      ...(workingDirectory ? { workingDirectory } : {}),
    });
    batch(() => {
      setChatState("sessions", sessionId, "restored", false);
      setChatState("sessions", sessionId, "error", null);
      setChatState("activeSessionId", sessionId);
      setChatState("selectedAgentId", session.agentId);
      setChatState("selectedMode", session.mode);
    });
    persistChatSessions();
    return sessionId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setError(sessionId, { sessionId, message });
    return null;
  } finally {
    setChatState("isCreatingSession", false);
  }
}

async function switchMode(mode: ChatMode): Promise<void> {
  const active = getActiveSession();
  if (chatState.selectedMode === mode && active?.mode === mode) {
    return;
  }
  setChatState("selectedMode", mode);
  if (active) {
    setChatState("sessions", active.id, "mode", mode);
  }
}

async function sendMessage(content: string, options: SendMessageOptions = {}): Promise<boolean> {
  const trimmed = content.trim();
  if (!trimmed || chatState.isCreatingSession || chatState.isSendingMessage) return false;

  const active = getActiveSession();
  if (active && active.status !== "idle") {
    if (active.status !== "error") return false;
    setChatState("activeSessionId", null);
  }

  const sessionId = await ensureSession();
  if (!sessionId) return false;

  const session = chatState.sessions[sessionId];
  if (!session) return false;

  const fileAttachments = [...session.fileAttachments];
  setChatState("isSendingMessage", true);

  try {
    const preparedFiles = await prepareEmbeddedFilesForSend(fileAttachments);
    const editorContext = createContextSnapshotSource().snapshot();
    const preparedSelection = prepareSelectedTextForSend(
      editorContext,
      options.includeSelectedText ?? true,
    );
    const messageAttachments = [
      ...(preparedSelection.messageAttachment ? [preparedSelection.messageAttachment] : []),
      ...preparedFiles.messageAttachments,
    ];

    setDraft("");
    clearFileAttachments(sessionId);
    appendTextMessage(sessionId, {
      kind: "text",
      role: "user",
      content: trimmed,
      ...(messageAttachments.length > 0 ? { attachments: messageAttachments } : {}),
    });

    setSessionStatus(sessionId, "streaming");
    setChatState("sessions", sessionId, "error", null);
    setChatState("sessions", sessionId, "finishReason", null);

    const handoffPrompt = pendingLegacyHandoffBySessionId.get(sessionId);
    const outboundContent = handoffPrompt ? `${handoffPrompt}\n\n${trimmed}` : trimmed;

    await invoke<void>("plugin:kuku-ai|ai_send_message", {
      agentId: session.agentId,
      sessionId,
      mode: chatState.selectedMode,
      content: outboundContent,
      editorContext: {
        ...editorContext,
        selectedText: preparedSelection.selectedText,
        embeddedFiles: preparedFiles.embeddedFiles,
      },
    });
    pendingLegacyHandoffBySessionId.delete(sessionId);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (chatState.sessions[sessionId]?.status === "streaming") {
      setError(sessionId, { sessionId, message });
    } else {
      setChatState("sessions", sessionId, "error", message);
      appendSystemMessage(sessionId, message);
    }
    return chatState.sessions[sessionId]?.status === "error";
  } finally {
    setChatState("isSendingMessage", false);
  }
}

async function cancelSession(): Promise<void> {
  const active = getActiveSession();
  if (!active) return;

  try {
    await invoke<void>("plugin:kuku-ai|ai_cancel", {
      agentId: active.agentId,
      sessionId: active.id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setError(active.id, {
      sessionId: active.id,
      message,
    });
  }
}

async function loadConfig(): Promise<void> {
  setChatState("config", "loading", true);
  setChatState("config", "error", null);
  try {
    const rawConfig = await loadPluginSettings<Record<string, unknown>>({
      pluginId: AI_CHAT_SETTINGS_PLUGIN_ID,
      defaults: {},
    });
    const config = await loadPluginSettings<AiConfig>({
      pluginId: AI_CHAT_SETTINGS_PLUGIN_ID,
      defaults: createDefaultAiConfig(),
      secureKeys: aiChatSecureKeysForRawSettings(rawConfig),
      normalize: (raw) => hydrateAiConfigExternalSecrets(normalizeAiConfig(raw), raw),
    });
    // Server URL and model are pinned to the build's bundled defaults —
    // they identify which backend this build targets and must not drift
    // into an older saved value from a previous variant or stale install.
    config.serverUrl = DEFAULT_SERVER_URL;
    config.model = DEFAULT_MODEL;
    await savePluginSettings(
      AI_CHAT_SETTINGS_PLUGIN_ID,
      prepareAiConfigForSave(config),
      aiChatSecureKeysForSave(config, rawConfig),
    );
    await invoke<void>("plugin:kuku-ai|ai_set_config", { config });
    setChatState("config", "rawConfig", config as unknown as Record<string, unknown>);
    setChatState("config", "apiKey", config.apiKey ?? "");
    setChatState("config", "provider", config.provider ?? DEFAULT_PROVIDER);
    setChatState("config", "serverUrl", config.serverUrl);
    setChatState("config", "model", config.model);
    setChatState("config", "externalAgents", config.externalAgents ?? DEFAULT_EXTERNAL_AGENTS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const defaults = createDefaultAiConfig();
    setChatState("config", "apiKey", defaults.apiKey ?? "");
    setChatState("config", "provider", defaults.provider ?? DEFAULT_PROVIDER);
    setChatState("config", "serverUrl", defaults.serverUrl ?? DEFAULT_SERVER_URL);
    setChatState("config", "model", defaults.model);
    setChatState("config", "externalAgents", defaults.externalAgents ?? DEFAULT_EXTERNAL_AGENTS);
    setChatState("config", "rawConfig", {});
    setChatState("config", "error", message);
  } finally {
    setChatState("config", "loading", false);
  }
}

async function saveConfig(
  nextProvider: "gemini" | "remote",
  nextApiKey: string,
  nextServerUrl: string,
): Promise<void> {
  setChatState("config", "saving", true);
  setChatState("config", "error", null);
  try {
    const rawConfig = await loadPluginSettings<Record<string, unknown>>({
      pluginId: AI_CHAT_SETTINGS_PLUGIN_ID,
      defaults: {},
    });
    const currentConfig = chatState.config.rawConfig as Partial<AiConfig>;
    const nextConfig: AiConfig = {
      provider: nextProvider,
      apiKey: nextApiKey || null,
      model: DEFAULT_MODEL,
      serverUrl: nextServerUrl || DEFAULT_SERVER_URL,
      externalAgents: chatState.config.externalAgents,
      roundLimit: currentConfig.roundLimit ?? DEFAULT_ROUND_LIMIT,
      proxyToolTimeoutMs: currentConfig.proxyToolTimeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS,
    };
    await savePluginSettings(
      AI_CHAT_SETTINGS_PLUGIN_ID,
      prepareAiConfigForSave(nextConfig),
      aiChatSecureKeysForSave(nextConfig, rawConfig),
    );
    await invoke<void>("plugin:kuku-ai|ai_set_config", { config: nextConfig });
    setChatState("config", "rawConfig", nextConfig as unknown as Record<string, unknown>);
    setChatState("config", "apiKey", nextApiKey);
    setChatState("config", "provider", nextProvider);
    setChatState("config", "serverUrl", nextServerUrl || DEFAULT_SERVER_URL);
    setChatState("config", "model", nextConfig.model);
    setChatState("config", "externalAgents", nextConfig.externalAgents ?? DEFAULT_EXTERNAL_AGENTS);
    await loadAgents();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setChatState("config", "error", message);
  } finally {
    setChatState("config", "saving", false);
  }
}

async function clearPersistedConfig(): Promise<void> {
  const rawConfig = await loadPluginSettings<Record<string, unknown>>({
    pluginId: AI_CHAT_SETTINGS_PLUGIN_ID,
    defaults: {},
  });
  await invoke<void>("plugin_clear_settings_with_secrets", {
    pluginId: AI_CHAT_SETTINGS_PLUGIN_ID,
    secureKeys: aiChatSecureKeysForRawSettings(rawConfig),
  });
}

async function loadTools(): Promise<void> {
  setChatState("config", "toolsLoading", true);
  setChatState("config", "toolsError", null);
  try {
    const tools = await invoke<ToolDescriptor[]>("plugin:kuku-ai|ai_list_tools");
    setChatState("config", "availableTools", tools);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setChatState("config", "availableTools", []);
    setChatState("config", "toolsError", message);
  } finally {
    setChatState("config", "toolsLoading", false);
  }
}

async function loadAgents(): Promise<void> {
  try {
    const agents = await invoke<AgentDescriptor[]>("plugin:kuku-ai|ai_list_agents");
    setChatAgents(agents);
  } catch {
    setChatAgents(BUILTIN_AGENT_CATALOG);
  }
}

async function loadSessions(vaultRoot?: string | null): Promise<void> {
  const requestId = (activeLoadSessionsRequestId += 1);
  const resolvedVaultRoot = vaultRoot === undefined ? await getCurrentVault() : vaultRoot;
  if (requestId !== activeLoadSessionsRequestId) return;

  const workingDirectory = setCurrentChatSessionVaultRoot(
    resolvedVaultRoot,
  );
  const isCurrentRequest = () =>
    requestId === activeLoadSessionsRequestId && currentChatSessionVaultRoot === workingDirectory;

  batch(() => {
    setChatState("sessions", {});
    setChatState("activeSessionId", null);
    bumpSessionSummariesVersion();
    setChatState("isLoadingSessions", true);
  });

  try {
    const backendSnapshots = await readBackendSessionSnapshots(workingDirectory);
    if (!isCurrentRequest()) return;

    const localSnapshots = readLocalSessionSnapshots(workingDirectory);
    if (localSnapshots.size > 0) {
      for (const snapshot of localSnapshots.values()) {
        const backendSnapshot = backendSnapshots.get(snapshot.id);
        if (!backendSnapshot || snapshot.updatedAt >= backendSnapshot.updatedAt) {
          backendSnapshots.set(snapshot.id, snapshot);
        }
      }
      await savePersistedChatSessionSnapshots(workingDirectory, [...backendSnapshots.values()]);
      if (!isCurrentRequest()) return;
      clearLocalSessionSnapshotsForVault(workingDirectory);
    }

    const sessionValues = workingDirectory
      ? await invoke<PersistedAgentSession[]>("plugin:kuku-ai|ai_list_sessions", {
          workingDirectory,
        })
      : await invoke<PersistedAgentSession[]>("plugin:kuku-ai|ai_list_sessions");
    if (!isCurrentRequest()) return;

    const sessions = scopedAgentSessions(sessionValues, workingDirectory);
    const loadedSessionIds = new Set<string>();
    for (const session of sessions) {
      loadedSessionIds.add(session.localSessionId);
      if (chatState.sessions[session.localSessionId]) continue;
      const snapshot = backendSnapshots.get(session.localSessionId);
      setChatState(
        "sessions",
        session.localSessionId,
        snapshot
          ? createStoredSessionState(snapshot, session, workingDirectory)
          : createPersistedSessionState(session, workingDirectory),
      );
    }

    for (const snapshot of backendSnapshots.values()) {
      if (loadedSessionIds.has(snapshot.id) || chatState.sessions[snapshot.id]) continue;
      setChatState(
        "sessions",
        snapshot.id,
        createStoredSessionState(snapshot, undefined, workingDirectory),
      );
    }
    bumpSessionSummariesVersion();

    if (!chatState.activeSessionId) {
      const [latest] = getSessionSummaries();
      if (latest) {
        switchSession(latest.id);
      }
    }
  } finally {
    if (isCurrentRequest()) {
      setChatState("isLoadingSessions", false);
    }
  }
}

function setExternalAgents(agents: AiConfig["externalAgents"]): void {
  setChatState("config", "externalAgents", normalizeExternalAgentConfigList(agents));
}

async function resolveApproval(
  sessionId: string,
  callId: string,
  decision: "Approve" | "Reject",
): Promise<void> {
  if (!chatState.sessions[sessionId]) return;
  if (decision === "Approve") {
    updateApprovalStatus(sessionId, callId, "approved");
    setSessionStatus(sessionId, "applying");
  } else {
    updateApprovalStatus(sessionId, callId, "rejected");
    setSessionStatus(sessionId, "streaming");
  }

  try {
    await invoke<void>("plugin:kuku-ai|ai_resolve_approval", {
      sessionId,
      callId,
      approved: decision === "Approve",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateApprovalStatus(sessionId, callId, "error", message);
    setSessionStatus(sessionId, "error");
    setChatState("sessions", sessionId, "error", message);
  }
}

export {
  addPendingApproval,
  addFileAttachment,
  appendDelta,
  chatState,
  cancelSession,
  clearFileAttachments,
  clearPersistedConfig,
  closeSession,
  createSession,
  endToolCall,
  ensureSession,
  finishSession,
  getActiveSession,
  resetChatState,
  loadAgents,
  loadConfig,
  loadSessions,
  loadTools,
  removeFileAttachment,
  resetToSession,
  getSessionSummaries,
  resolveApproval,
  saveConfig,
  sendMessage,
  setExternalAgents,
  setAutoApprove,
  setChatAgents,
  setDraft,
  setError,
  isSessionBusy,
  setPermissionPreset,
  setSelectedAgent,
  setSelectedMode,
  setSessionStatus,
  startToolCall,
  switchMode,
  switchSession,
  toggleApprovalExpanded,
  toggleToolExpanded,
  updateApprovalStatus,
};
