import { describe, expect, it, vi } from "vitest";

import {
  createChatSessionPersistence,
  serializeSessionForStorage,
} from "./chat_session_persistence";
import type { ChatSessionState } from "./types";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

class StorageMock {
  private readonly data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

function session(overrides: Partial<ChatSessionState> = {}): ChatSessionState {
  return {
    id: "session-1",
    agentId: "kuku-native",
    mode: "ask",
    createdAt: 1,
    updatedAt: 2,
    workingDirectory: "/Users/me/Vault",
    draft: "draft",
    fileAttachments: [],
    messages: [
      {
        id: "message-1",
        kind: "text",
        role: "assistant",
        content: "streaming",
        streaming: true,
      },
      {
        id: "approval-1",
        kind: "approval",
        callId: "call-1",
        toolName: "edit_file",
        mutation: {},
        expanded: true,
        status: "pending",
      },
    ],
    inflightAssistantId: null,
    autoApprove: true,
    status: "idle",
    error: null,
    finishReason: null,
    ...overrides,
  };
}

describe("chat session persistence", () => {
  it("serializes runtime-only message state into restart-safe snapshots", () => {
    const snapshot = serializeSessionForStorage(session(), "/Users/me/Vault");

    expect(snapshot.messages).toMatchObject([
      {
        id: "message-1",
        kind: "text",
        streaming: false,
      },
      {
        id: "approval-1",
        kind: "approval",
        expanded: false,
        status: "error",
        error: "Pending approval was interrupted by app restart.",
      },
    ]);
  });

  it("reads only scoped local snapshots from storage", () => {
    const storage = new StorageMock();
    storage.setItem(
      "kuku.aiChat.sessions.v1:%2FUsers%2Fme%2FVault",
      JSON.stringify({
        version: 1,
        sessions: [
          {
            id: "session-1",
            agentId: "kuku-native",
            mode: "ask",
            createdAt: 1,
            updatedAt: 2,
            workingDirectory: "/Users/me/Vault/",
            draft: "draft",
            autoApprove: true,
            messages: [{ id: "message-1", kind: "text", role: "user", content: "hello" }],
          },
        ],
      }),
    );
    const persistence = createChatSessionPersistence({
      storage: () => storage,
      invoke: mockInvoke,
    });

    const snapshots = persistence.readLocalSessionSnapshots("/Users/me/Vault");

    expect([...snapshots.values()]).toMatchObject([
      {
        id: "session-1",
        workingDirectory: "/Users/me/Vault",
        draft: "draft",
      },
    ]);
  });

  it("normalizes stored streaming text messages when reading snapshots", () => {
    const storage = new StorageMock();
    storage.setItem(
      "kuku.aiChat.sessions.v1:%2FUsers%2Fme%2FVault",
      JSON.stringify({
        version: 1,
        sessions: [
          {
            id: "session-1",
            agentId: "kuku-native",
            mode: "ask",
            createdAt: 1,
            updatedAt: 2,
            workingDirectory: "/Users/me/Vault",
            draft: "",
            autoApprove: false,
            messages: [
              {
                id: "assistant-1",
                kind: "text",
                role: "assistant",
                content: "interrupted",
                streaming: true,
              },
            ],
          },
        ],
      }),
    );
    const persistence = createChatSessionPersistence({
      storage: () => storage,
      invoke: mockInvoke,
    });

    const [snapshot] = persistence.readLocalSessionSnapshots("/Users/me/Vault").values();

    expect(snapshot?.messages).toMatchObject([
      {
        id: "assistant-1",
        kind: "text",
        role: "assistant",
        content: "interrupted",
        streaming: false,
      },
    ]);
  });
});
