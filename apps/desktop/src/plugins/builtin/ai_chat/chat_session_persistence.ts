import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import {
  CHAT_SESSIONS_STORAGE_KEY,
  chatSessionStorageKey,
  filterForChatSessionVaultRoot,
  normalizeChatSessionVaultRoot,
} from "./chat_session_scope";
import type {
  ChatMessage,
  ChatMode,
  ChatSessionState,
  ChatTextMessage,
  PersistedChatSessionSnapshot,
} from "./types";

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface ChatSessionPersistenceOptions {
  storage?: () => Storage | null;
  invoke?: InvokeFn;
}

interface ChatSessionPersistence {
  readLocalSessionSnapshots(vaultRoot: string | null): Map<string, PersistedChatSessionSnapshot>;
  readBackendSessionSnapshots(
    workingDirectory: string | null,
  ): Promise<Map<string, PersistedChatSessionSnapshot>>;
  savePersistedChatSessionSnapshots(
    workingDirectory: string | null,
    sessions: PersistedChatSessionSnapshot[],
  ): Promise<void>;
  clearLocalSessionSnapshots(): void;
  clearLocalSessionSnapshotsForVault(vaultRoot: string | null): void;
}

function createChatSessionPersistence(
  options: ChatSessionPersistenceOptions = {},
): ChatSessionPersistence {
  const storage = options.storage ?? getChatSessionStorage;
  const invoke = options.invoke ?? tauriInvoke;

  return {
    readLocalSessionSnapshots(vaultRoot) {
      const raw = storage()?.getItem(chatSessionStorageKey(vaultRoot));
      if (!raw) return new Map();

      try {
        const parsed = asRecord(JSON.parse(raw));
        if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
          return new Map();
        }

        const snapshots = new Map<string, PersistedChatSessionSnapshot>();
        for (const value of parsed.sessions) {
          const snapshot = normalizePersistedSessionSnapshot(value);
          if (!snapshot) continue;
          snapshots.set(snapshot.id, snapshot);
        }

        return snapshots;
      } catch {
        return new Map();
      }
    },

    async readBackendSessionSnapshots(workingDirectory) {
      try {
        const values = await invoke<PersistedChatSessionSnapshot[]>(
          "plugin:kuku-ai|ai_list_chat_sessions",
          workingDirectory ? { workingDirectory } : undefined,
        );
        const scopedValues = filterForChatSessionVaultRoot(values, workingDirectory);
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
    },

    async savePersistedChatSessionSnapshots(workingDirectory, sessions) {
      try {
        await invoke<void>("plugin:kuku-ai|ai_save_chat_sessions", {
          ...(workingDirectory ? { workingDirectory } : {}),
          sessions,
        });
      } catch {
        // Keep the in-memory chat usable even if persistence is temporarily unavailable.
      }
    },

    clearLocalSessionSnapshots() {
      try {
        const activeStorage = storage();
        if (!activeStorage) return;
        const keys: string[] = [];
        for (let index = 0; index < activeStorage.length; index += 1) {
          const key = activeStorage.key(index);
          if (
            key === CHAT_SESSIONS_STORAGE_KEY ||
            key?.startsWith(`${CHAT_SESSIONS_STORAGE_KEY}:`)
          ) {
            keys.push(key);
          }
        }
        for (const key of keys) {
          activeStorage.removeItem(key);
        }
      } catch {
        // Ignore storage failures during reset.
      }
    },

    clearLocalSessionSnapshotsForVault(vaultRoot) {
      try {
        const activeStorage = storage();
        if (!activeStorage) return;
        activeStorage.removeItem(chatSessionStorageKey(vaultRoot));
        if (vaultRoot === null) {
          activeStorage.removeItem(CHAT_SESSIONS_STORAGE_KEY);
        }
      } catch {
        // Ignore storage failures during migration cleanup.
      }
    },
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

function normalizePersistedSessionSnapshot(value: unknown): PersistedChatSessionSnapshot | null {
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

function serializeSessionForStorage(
  session: ChatSessionState,
  fallbackWorkingDirectory: string | null,
): PersistedChatSessionSnapshot {
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
    workingDirectory: session.workingDirectory ?? fallbackWorkingDirectory,
    draft: session.draft,
    autoApprove: session.autoApprove,
    messages: session.messages.map(serializeChatMessageForStorage),
  };
}

export {
  createChatSessionPersistence,
  normalizePersistedSessionSnapshot,
  serializeChatMessageForStorage,
  serializeSessionForStorage,
};

export type { ChatSessionPersistence };
