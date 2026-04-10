import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("./approval_diff", () => ({
  openApprovalDiff: vi.fn(),
}));

vi.mock("./context_snapshot", () => ({
  createContextSnapshotSource: () => ({
    snapshot: () => ({
      activeFile: null,
      selectedText: null,
      openTabs: [],
      cursorLine: null,
    }),
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

describe("ai_chat chat_store config", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("loads persisted plugin settings and syncs runtime config", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin_get_settings":
          return {
            provider: "remote",
            apiKey: null,
            model: "custom-model",
            serverUrl: "https://www.kuku.mom",
            roundLimit: 16,
            proxyToolTimeoutMs: 30_000,
          };
        case "plugin:kuku-ai|ai_set_config":
          return undefined;
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();

    await chat.loadConfig();

    expect(mockInvoke).toHaveBeenCalledWith("plugin:kuku-ai|ai_set_config", {
      config: {
        provider: "remote",
        apiKey: null,
        model: "custom-model",
        serverUrl: "https://www.kuku.mom",
        roundLimit: 16,
        proxyToolTimeoutMs: 30_000,
      },
    });
    expect(chat.chatState.config.provider).toBe("remote");
    expect(chat.chatState.config.model).toBe("custom-model");
  });

  it("saves plugin settings before syncing runtime config", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin_save_settings":
        case "plugin:kuku-ai|ai_set_config":
          return undefined;
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();

    await chat.saveConfig("remote", "", "saved-model", "https://saved");

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "plugin_save_settings", {
      pluginId: "ai-chat",
      settings: {
        provider: "remote",
        apiKey: null,
        model: "saved-model",
        serverUrl: "https://saved",
        roundLimit: 12,
        proxyToolTimeoutMs: 15_000,
      },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "plugin:kuku-ai|ai_set_config", {
      config: {
        provider: "remote",
        apiKey: null,
        model: "saved-model",
        serverUrl: "https://saved",
        roundLimit: 12,
        proxyToolTimeoutMs: 15_000,
      },
    });
  });
});
