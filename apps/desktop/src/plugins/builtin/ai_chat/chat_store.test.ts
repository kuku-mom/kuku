import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();
const mockReadVaultFileWithChecksum = vi.fn();
const mockContextSnapshot = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("~/lib/vault_fs", () => ({
  readVaultFileWithChecksum: mockReadVaultFileWithChecksum,
}));

vi.mock("./approval_diff", () => ({
  openApprovalDiff: vi.fn(),
}));

vi.mock("./context_snapshot", () => ({
  createContextSnapshotSource: () => ({
    snapshot: mockContextSnapshot,
  }),
}));

vi.mock("./responding_state", () => ({
  hasRespondingSession: () => false,
}));

vi.mock("~/plugins/context_keys", () => ({
  setContextKey: vi.fn(),
}));

async function loadChatStoreModule() {
  vi.resetModules();
  return import("./chat_store");
}

function defaultEditorContext() {
  return {
    activeFile: null,
    selectedText: null,
    openTabs: [],
    cursorLine: null,
  };
}

describe("ai_chat chat_store config", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockReadVaultFileWithChecksum.mockReset();
    mockContextSnapshot.mockReset();
    mockContextSnapshot.mockImplementation(defaultEditorContext);
  });

  it("loads persisted plugin settings and pins server url + model to build defaults", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin_get_settings_with_secrets":
          return {
            provider: "remote",
            apiKey: null,
            model: "gemini-3.1-flash-lite-preview",
            serverUrl: "https://www.kuku.mom",
            roundLimit: 16,
            proxyToolTimeoutMs: 30_000,
          };
        case "plugin_save_settings_with_secrets":
        case "plugin:kuku-ai|ai_set_config":
          return undefined;
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();

    await chat.loadConfig();

    expect(mockInvoke).toHaveBeenCalledWith("plugin_get_settings_with_secrets", {
      pluginId: "ai-chat",
      secureKeys: ["apiKey"],
    });
    // serverUrl and model are pinned to build defaults — persisted values for
    // those fields are intentionally dropped so the runtime targets the
    // backend this build was compiled against.
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "plugin_save_settings_with_secrets", {
      pluginId: "ai-chat",
      settings: {
        provider: "remote",
        apiKey: null,
        model: "gemini-3.1-flash-lite",
        serverUrl: "http://localhost:8080",
        roundLimit: 16,
        proxyToolTimeoutMs: 30_000,
      },
      secureKeys: ["apiKey"],
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "plugin:kuku-ai|ai_set_config", {
      config: {
        provider: "remote",
        apiKey: null,
        model: "gemini-3.1-flash-lite",
        serverUrl: "http://localhost:8080",
        roundLimit: 16,
        proxyToolTimeoutMs: 30_000,
      },
    });
    expect(chat.chatState.config.provider).toBe("remote");
    expect(chat.chatState.config.model).toBe("gemini-3.1-flash-lite");
    expect(chat.chatState.config.serverUrl).toBe("http://localhost:8080");
  });

  it("pins saved plugin settings to the build default model before syncing runtime config", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin_save_settings_with_secrets":
        case "plugin:kuku-ai|ai_set_config":
          return undefined;
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();

    await chat.saveConfig("remote", "", "https://saved");

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "plugin_save_settings_with_secrets", {
      pluginId: "ai-chat",
      settings: {
        provider: "remote",
        apiKey: null,
        model: "gemini-3.1-flash-lite",
        serverUrl: "https://saved",
        roundLimit: 12,
        proxyToolTimeoutMs: 15_000,
      },
      secureKeys: ["apiKey"],
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "plugin:kuku-ai|ai_set_config", {
      config: {
        provider: "remote",
        apiKey: null,
        model: "gemini-3.1-flash-lite",
        serverUrl: "https://saved",
        roundLimit: 12,
        proxyToolTimeoutMs: 15_000,
      },
    });
  });

  it("clears persisted secure settings through secure-aware command", async () => {
    mockInvoke.mockResolvedValue(undefined);

    const chat = await loadChatStoreModule();

    await chat.clearPersistedConfig();

    expect(mockInvoke).toHaveBeenCalledWith("plugin_clear_settings_with_secrets", {
      pluginId: "ai-chat",
      secureKeys: ["apiKey"],
    });
  });
});

describe("ai_chat chat_store session modes", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockReadVaultFileWithChecksum.mockReset();
    mockContextSnapshot.mockReset();
    mockContextSnapshot.mockImplementation(defaultEditorContext);
  });

  it("switches mode without creating a new session", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_new_session":
          return { sessionId: "session-1" };
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();

    await chat.createSession("ask");
    chat.setDraft("keep this draft");
    await chat.switchMode("agent");

    expect(chat.chatState.activeSessionId).toBe("session-1");
    expect(chat.chatState.selectedMode).toBe("agent");
    expect(chat.chatState.sessions["session-1"]?.mode).toBe("agent");
    expect(chat.chatState.sessions["session-1"]?.draft).toBe("keep this draft");
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("plugin:kuku-ai|ai_new_session", {
      mode: "ask",
    });
  });

  it("can switch back to ask mode without creating a new session", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_new_session":
          return { sessionId: "session-1" };
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();

    await chat.createSession("ask");
    await chat.switchMode("agent");
    await chat.switchMode("ask");

    expect(chat.chatState.activeSessionId).toBe("session-1");
    expect(chat.chatState.selectedMode).toBe("ask");
    expect(chat.chatState.sessions["session-1"]?.mode).toBe("ask");
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("keeps the current session when sending after a mode switch", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_new_session":
          return { sessionId: "session-1" };
        case "plugin:kuku-ai|ai_send_message":
          return undefined;
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();

    await chat.createSession("ask");
    await chat.switchMode("agent");
    await chat.sendMessage("edit this note");

    expect(chat.chatState.activeSessionId).toBe("session-1");
    expect(chat.chatState.sessions["session-1"]?.messages).toMatchObject([
      {
        kind: "text",
        role: "user",
        content: "edit this note",
      },
    ]);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "plugin:kuku-ai|ai_send_message", {
      sessionId: "session-1",
      mode: "agent",
      content: "edit this note",
      editorContext: {
        activeFile: null,
        selectedText: null,
        openTabs: [],
        cursorLine: null,
        embeddedFiles: [],
      },
    });
  });

  it("sends attached files as embedded editor context", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_new_session":
          return { sessionId: "session-1" };
        case "plugin:kuku-ai|ai_send_message":
          return undefined;
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });
    mockReadVaultFileWithChecksum.mockResolvedValue({
      content: "# Base\ncontent",
      checksum: "checksum-1",
    });

    const chat = await loadChatStoreModule();

    await chat.createSession("agent");
    await chat.addFileAttachment({
      name: "Base",
      path: "notes/Base.md",
      folder: "notes",
    });
    await chat.sendMessage("summarize this");

    expect(mockReadVaultFileWithChecksum).toHaveBeenCalledWith("notes/Base.md");
    expect(chat.chatState.sessions["session-1"]?.fileAttachments).toEqual([]);
    expect(chat.chatState.sessions["session-1"]?.messages).toMatchObject([
      {
        kind: "text",
        role: "user",
        content: "summarize this",
        attachments: [
          {
            kind: "file",
            path: "notes/Base.md",
            name: "Base",
            sizeBytes: 14,
          },
        ],
      },
    ]);
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "plugin:kuku-ai|ai_send_message", {
      sessionId: "session-1",
      mode: "agent",
      content: "summarize this",
      editorContext: {
        activeFile: null,
        selectedText: null,
        openTabs: [],
        cursorLine: null,
        embeddedFiles: [
          {
            path: "notes/Base.md",
            content: "# Base\ncontent",
            checksum: "checksum-1",
            sizeBytes: 14,
          },
        ],
      },
    });
  });

  it("sends selected text as visible turn context by default", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_new_session":
          return { sessionId: "session-1" };
        case "plugin:kuku-ai|ai_send_message":
          return undefined;
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });
    mockContextSnapshot.mockImplementation(() => ({
      activeFile: "notes/Base.md",
      selectedText: "selected paragraph",
      openTabs: [],
      cursorLine: null,
    }));

    const chat = await loadChatStoreModule();

    await chat.createSession("ask");
    await chat.sendMessage("explain this");

    expect(chat.chatState.sessions["session-1"]?.messages).toMatchObject([
      {
        kind: "text",
        role: "user",
        content: "explain this",
        attachments: [
          {
            kind: "selection",
            activeFile: "notes/Base.md",
            sizeBytes: 18,
          },
        ],
      },
    ]);
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "plugin:kuku-ai|ai_send_message", {
      sessionId: "session-1",
      mode: "ask",
      content: "explain this",
      editorContext: {
        activeFile: "notes/Base.md",
        selectedText: "selected paragraph",
        openTabs: [],
        cursorLine: null,
        embeddedFiles: [],
      },
    });
  });

  it("can disable selected text context for precomposed prompts", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_new_session":
          return { sessionId: "session-1" };
        case "plugin:kuku-ai|ai_send_message":
          return undefined;
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });
    mockContextSnapshot.mockImplementation(() => ({
      activeFile: "notes/Base.md",
      selectedText: "selected paragraph",
      openTabs: [],
      cursorLine: null,
    }));

    const chat = await loadChatStoreModule();

    await chat.createSession("ask");
    await chat.sendMessage("prompt already contains selection", { includeSelectedText: false });

    expect(chat.chatState.sessions["session-1"]?.messages).toMatchObject([
      {
        kind: "text",
        role: "user",
        content: "prompt already contains selection",
      },
    ]);
    expect(chat.chatState.sessions["session-1"]?.messages[0]).not.toHaveProperty("attachments");
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "plugin:kuku-ai|ai_send_message", {
      sessionId: "session-1",
      mode: "ask",
      content: "prompt already contains selection",
      editorContext: {
        activeFile: "notes/Base.md",
        selectedText: null,
        openTabs: [],
        cursorLine: null,
        embeddedFiles: [],
      },
    });
  });

  it("lets the next selected mode change while the active session is busy", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_new_session":
          return { sessionId: "session-1" };
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();

    await chat.createSession("ask");
    chat.setSessionStatus("session-1", "streaming");
    await chat.switchMode("agent");

    expect(chat.chatState.selectedMode).toBe("agent");
    expect(chat.chatState.sessions["session-1"]?.mode).toBe("agent");
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });
});
