import { listen } from "@tauri-apps/api/event";
import type { ProxyToolCallPayload } from "~/plugins/builtin/core_tool_registry/types";

import {
  addPendingApproval,
  appendDelta,
  endToolCall,
  finishSession,
  setError,
  setSessionStatus,
  startToolCall,
} from "./chat_store";
import type {
  DonePayload,
  ErrorPayload,
  PendingApprovalPayload,
  StreamChunkPayload,
  ToolCallEndPayload,
  ToolCallStartPayload,
} from "./types";

// TEMP DEBUG: remove after tool round continuation is verified in runtime.
const DEBUG_AI_EVENTS = import.meta.env.DEV;

function normalizeSessionId(payload: { sessionId?: string }): string | null {
  return payload.sessionId ?? null;
}

function debugAiEvent(name: string, payload: unknown): void {
  if (!DEBUG_AI_EVENTS) return;
  // eslint-disable-next-line no-console
  console.debug("[ai-debug][event]", name, payload);
}

async function createAiEventBridge(): Promise<() => void> {
  const unlisten = await Promise.all([
    listen<StreamChunkPayload>("ai:stream-chunk", (event) => {
      debugAiEvent("ai:stream-chunk", event.payload);
      const sessionId = normalizeSessionId(event.payload);
      if (!sessionId) return;
      appendDelta(sessionId, event.payload.delta);
      setSessionStatus(sessionId, "streaming");
    }),
    listen<ToolCallStartPayload>("ai:tool-call-start", (event) => {
      debugAiEvent("ai:tool-call-start", event.payload);
      const sessionId = normalizeSessionId(event.payload);
      if (!sessionId) return;
      startToolCall(event.payload);
      setSessionStatus(sessionId, "streaming");
    }),
    listen<ToolCallEndPayload>("ai:tool-call-end", (event) => {
      debugAiEvent("ai:tool-call-end", event.payload);
      const sessionId = normalizeSessionId(event.payload);
      if (!sessionId) return;
      endToolCall(event.payload);
      setSessionStatus(sessionId, "streaming");
    }),
    listen<PendingApprovalPayload>("ai:pending-approval", (event) => {
      debugAiEvent("ai:pending-approval", event.payload);
      const sessionId = normalizeSessionId(event.payload);
      if (!sessionId) return;
      const autoApproved = addPendingApproval(event.payload);
      if (!autoApproved) {
        setSessionStatus(sessionId, "awaiting-approval");
      }
    }),
    listen<ProxyToolCallPayload>("ai:proxy-tool-call", (event) => {
      debugAiEvent("ai:proxy-tool-call", event.payload);
      const sessionId = normalizeSessionId(event.payload);
      if (!sessionId) return;
      startToolCall(event.payload);
      setSessionStatus(sessionId, "streaming");
    }),
    listen<DonePayload>("ai:done", (event) => {
      debugAiEvent("ai:done", event.payload);
      const sessionId = normalizeSessionId(event.payload);
      if (!sessionId) return;
      finishSession(sessionId, event.payload);
    }),
    listen<ErrorPayload>("ai:error", (event) => {
      debugAiEvent("ai:error", event.payload);
      const sessionId = normalizeSessionId(event.payload);
      if (!sessionId) return;
      setError(sessionId, event.payload);
    }),
  ]);

  return () => {
    for (const dispose of unlisten) {
      dispose();
    }
  };
}

export { createAiEventBridge };
