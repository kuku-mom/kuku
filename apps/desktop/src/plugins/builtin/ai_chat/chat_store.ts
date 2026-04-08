import { invoke } from "@tauri-apps/api/core";
import { createStore } from "solid-js/store";

import { openApprovalDiff } from "./approval_diff";
import { createContextSnapshotSource } from "./context_snapshot";
import { hasRespondingSession } from "./responding_state";
import type {
  AiConfig,
  ChatApprovalMessage,
  ChatMessage,
  ChatMode,
  ChatSessionState,
  ChatStoreState,
  ChatTextMessage,
  ChatToolMessage,
  DonePayload,
  ErrorPayload,
  NewSessionPayload,
  PendingApprovalPayload,
  ToolCallEndPayload,
  ToolCallStartPayload,
  ToolDescriptor,
} from "./types";
import { setContextKey } from "~/plugins/context_keys";

const DEFAULT_MODEL = "gemini-3.1-flash-lite-preview";
const DEFAULT_PROVIDER = "gemini" as const;
const DEFAULT_SERVER_URL = "http://localhost:8080";
const DEFAULT_ROUND_LIMIT = 8;
const DEFAULT_PROXY_TIMEOUT_MS = 15_000;
const BUSY_SESSION_STATUSES: ChatSessionState["status"][] = [
  "streaming",
  "awaiting-approval",
  "applying",
];

const [chatState, setChatState] = createStore<ChatStoreState>({
  selectedMode: "ask",
  activeSessionId: null,
  sessions: {},
  isCreatingSession: false,
  isSendingMessage: false,
  config: {
    apiKey: "",
    provider: DEFAULT_PROVIDER,
    serverUrl: DEFAULT_SERVER_URL,
    model: DEFAULT_MODEL,
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

setContextKey("aiResponding", false);

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

function createSessionState(id: string, mode: ChatMode): ChatSessionState {
  return {
    id,
    mode,
    draft: "",
    messages: [],
    inflightAssistantId: null,
    autoApprove: false,
    status: "idle",
    error: null,
    finishReason: null,
  };
}

function isSessionBusy(session: ChatSessionState | null | undefined): boolean {
  return session != null && BUSY_SESSION_STATUSES.includes(session.status);
}

function setSelectedMode(mode: ChatMode): void {
  setChatState("selectedMode", mode);
}

function setDraft(value: string): void {
  const session = getActiveSession();
  if (!session) return;
  setChatState("sessions", session.id, "draft", value);
}

function setSessionStatus(sessionId: string, status: ChatSessionState["status"]): void {
  if (chatState.sessions[sessionId]) {
    setChatState("sessions", sessionId, "status", status);
    syncRespondingState();
  }
}

function appendTextMessage(
  sessionId: string,
  message: Omit<Extract<ChatMessage, { kind: "text" }>, "id">,
): void {
  if (!chatState.sessions[sessionId]) return;
  const nextMessage: ChatTextMessage = { id: crypto.randomUUID(), ...message };
  setChatState("sessions", sessionId, "messages", (prev) => [...prev, nextMessage]);
}

function appendSystemMessage(sessionId: string, content: string): void {
  appendTextMessage(sessionId, {
    kind: "text",
    role: "system",
    content,
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
  setChatState("sessions", sessionId, "messages", (prev) => [...prev, assistantMessage]);
  setChatState("sessions", sessionId, "inflightAssistantId", id);
  setSessionStatus(sessionId, "streaming");
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

  const current = session.messages[index];
  if (current.kind === "text") {
    setChatState("sessions", sessionId, "messages", index, {
      ...current,
      streaming: false,
    });
  }
  setChatState("sessions", sessionId, "inflightAssistantId", null);
}

function appendDelta(sessionId: string, delta: string): void {
  const session = chatState.sessions[sessionId];
  if (!session) return;

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
  setSessionStatus(sessionId, "streaming");
}

function finishSession(sessionId: string, payload: DonePayload): void {
  const session = chatState.sessions[sessionId];
  if (!session) return;

  closeAssistantSegment(sessionId);
  setChatState("sessions", sessionId, "finishReason", payload.finishReason);
  if (payload.finishReason === "error") {
    setSessionStatus(sessionId, "error");
    return;
  }

  setSessionStatus(sessionId, "idle");
  setChatState("sessions", sessionId, "error", null);
}

function setError(sessionId: string, payload: ErrorPayload): void {
  const session = chatState.sessions[sessionId];
  if (!session) return;

  closeAssistantSegment(sessionId);
  setSessionStatus(sessionId, "error");
  setChatState("sessions", sessionId, "error", payload.message);
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
    return;
  }

  setChatState("sessions", payload.sessionId, "messages", (prev) => [...prev, toolMessage]);
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
}

function setAutoApprove(sessionId: string, enabled: boolean): void {
  const session = chatState.sessions[sessionId];
  if (!session || chatState.activeSessionId !== sessionId) return;

  setChatState("sessions", sessionId, "autoApprove", enabled);
  if (!enabled) return;

  const pendingApprovals = session.messages.filter(
    (message): message is ChatApprovalMessage =>
      message.kind === "approval" && message.status === "pending",
  );

  for (const approval of pendingApprovals) {
    void resolveApproval(sessionId, approval.callId, "Approve");
  }
}

function resetToSession(sessionId: string, mode: ChatMode): void {
  const current = chatState.sessions[sessionId];
  if (!current) {
    setChatState("sessions", sessionId, createSessionState(sessionId, mode));
  } else {
    setChatState("sessions", sessionId, "mode", mode);
  }
  setChatState("activeSessionId", sessionId);
  setChatState("selectedMode", mode);
}

async function createSession(mode: ChatMode = chatState.selectedMode): Promise<string | null> {
  const active = getActiveSession();
  if (isSessionBusy(active)) {
    return active?.id ?? null;
  }

  setChatState("isCreatingSession", true);
  try {
    const payload = await invoke<NewSessionPayload>("plugin:kuku-ai|ai_new_session", {
      mode,
    });
    resetToSession(payload.sessionId, mode);
    return payload.sessionId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const currentSession = getActiveSession();
    if (currentSession) {
      setError(currentSession.id, { sessionId: currentSession.id, message });
      appendSystemMessage(currentSession.id, message);
    }
    return null;
  } finally {
    setChatState("isCreatingSession", false);
  }
}

async function ensureSession(): Promise<string | null> {
  const active = getActiveSession();
  const mode = chatState.selectedMode;
  if (active && active.mode === mode) {
    return active.id;
  }
  return createSession(mode);
}

async function switchMode(mode: ChatMode): Promise<void> {
  const active = getActiveSession();
  if (chatState.selectedMode === mode && active?.mode === mode) {
    return;
  }
  if (isSessionBusy(active)) {
    return;
  }
  await createSession(mode);
}

async function sendMessage(content: string): Promise<void> {
  const trimmed = content.trim();
  if (!trimmed || chatState.isCreatingSession || chatState.isSendingMessage) return;

  const active = getActiveSession();
  if (active && active.status !== "idle") return;

  const sessionId = await ensureSession();
  if (!sessionId) return;

  const session = chatState.sessions[sessionId];
  if (!session) return;

  setDraft("");
  appendTextMessage(sessionId, {
    kind: "text",
    role: "user",
    content: trimmed,
  });

  setSessionStatus(sessionId, "streaming");
  setChatState("sessions", sessionId, "error", null);
  setChatState("sessions", sessionId, "finishReason", null);
  setChatState("isSendingMessage", true);

  try {
    await invoke<void>("plugin:kuku-ai|ai_send_message", {
      sessionId,
      content: trimmed,
      editorContext: createContextSnapshotSource().snapshot(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setError(sessionId, {
      sessionId,
      message,
    });
    appendSystemMessage(sessionId, message);
  } finally {
    setChatState("isSendingMessage", false);
  }
}

async function cancelSession(): Promise<void> {
  const active = getActiveSession();
  if (!active) return;

  try {
    await invoke<void>("plugin:kuku-ai|ai_cancel", {
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
    const config = await invoke<AiConfig>("plugin:kuku-ai|ai_get_config");
    setChatState("config", "rawConfig", config as unknown as Record<string, unknown>);
    setChatState("config", "apiKey", config.apiKey ?? "");
    setChatState("config", "provider", config.provider ?? DEFAULT_PROVIDER);
    setChatState("config", "serverUrl", config.serverUrl ?? DEFAULT_SERVER_URL);
    setChatState("config", "model", config.model || DEFAULT_MODEL);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setChatState("config", "apiKey", "");
    setChatState("config", "provider", DEFAULT_PROVIDER);
    setChatState("config", "serverUrl", DEFAULT_SERVER_URL);
    setChatState("config", "model", DEFAULT_MODEL);
    setChatState("config", "rawConfig", {});
    setChatState("config", "error", message);
  } finally {
    setChatState("config", "loading", false);
  }
}

async function saveConfig(
  nextProvider: "gemini" | "remote",
  nextApiKey: string,
  nextModel: string,
  nextServerUrl: string,
): Promise<void> {
  setChatState("config", "saving", true);
  setChatState("config", "error", null);
  try {
    const currentConfig = chatState.config.rawConfig as Partial<AiConfig>;
    const nextConfig: AiConfig = {
      provider: nextProvider,
      apiKey: nextApiKey || null,
      model: nextModel || DEFAULT_MODEL,
      serverUrl: nextServerUrl || DEFAULT_SERVER_URL,
      roundLimit: currentConfig.roundLimit ?? DEFAULT_ROUND_LIMIT,
      proxyToolTimeoutMs: currentConfig.proxyToolTimeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS,
    };
    await invoke<void>("plugin:kuku-ai|ai_set_config", { config: nextConfig });
    setChatState("config", "rawConfig", nextConfig as unknown as Record<string, unknown>);
    setChatState("config", "apiKey", nextApiKey);
    setChatState("config", "provider", nextProvider);
    setChatState("config", "serverUrl", nextServerUrl || DEFAULT_SERVER_URL);
    setChatState("config", "model", nextModel || DEFAULT_MODEL);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setChatState("config", "error", message);
  } finally {
    setChatState("config", "saving", false);
  }
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
  appendDelta,
  chatState,
  cancelSession,
  createSession,
  endToolCall,
  ensureSession,
  finishSession,
  getActiveSession,
  loadConfig,
  loadTools,
  resetToSession,
  resolveApproval,
  saveConfig,
  sendMessage,
  setAutoApprove,
  setDraft,
  setError,
  isSessionBusy,
  setSelectedMode,
  setSessionStatus,
  startToolCall,
  switchMode,
  toggleApprovalExpanded,
  toggleToolExpanded,
  updateApprovalStatus,
};
