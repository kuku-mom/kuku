import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();
const mockReadVaultFileWithChecksum = vi.fn();
const mockContextSnapshot = vi.fn();
const mockGetCurrentVault = vi.fn();
const CHAT_SESSIONS_STORAGE_KEY = "kuku.aiChat.sessions.v1";
const scopedChatSessionsStorageKey = (vaultRoot: string | null) =>
  `${CHAT_SESSIONS_STORAGE_KEY}:${encodeURIComponent(vaultRoot ?? "no-vault")}`;

class StorageMock {
  private readonly data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
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

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("~/lib/vault_fs", () => ({
  readVaultFileWithChecksum: mockReadVaultFileWithChecksum,
  getCurrentVault: mockGetCurrentVault,
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

function defaultExternalAgents() {
  return [
    {
      id: "codex-acp",
      label: "Codex CLI",
      command: "npx",
      args: ["-y", "@zed-industries/codex-acp@latest"],
      env: {},
      enabled: true,
    },
  ];
}

function enabledCodexAgents() {
  return [
    {
      id: "kuku-native",
      label: "Kuku Agent",
      kind: "native" as const,
      enabled: true,
      managed: true,
    },
    {
      id: "codex-acp",
      label: "Codex CLI",
      kind: "acp" as const,
      enabled: true,
      managed: true,
    },
  ];
}

describe("ai_chat chat_store config", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockReadVaultFileWithChecksum.mockReset();
    mockContextSnapshot.mockReset();
    mockGetCurrentVault.mockReset();
    mockGetCurrentVault.mockResolvedValue(null);
    mockContextSnapshot.mockImplementation(defaultEditorContext);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: new StorageMock(),
    });
  });

  it("loads persisted plugin settings and pins server url + model to build defaults", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin_get_settings":
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

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "plugin_get_settings", {
      pluginId: "ai-chat",
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "plugin_get_settings_with_secrets", {
      pluginId: "ai-chat",
      secureKeys: ["apiKey"],
    });
    // serverUrl and model are pinned to build defaults — persisted values for
    // those fields are intentionally dropped so the runtime targets the
    // backend this build was compiled against.
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "plugin_save_settings_with_secrets", {
      pluginId: "ai-chat",
      settings: {
        provider: "remote",
        apiKey: null,
        model: "gemini-3.1-flash-lite",
        serverUrl: "http://localhost:8080",
        externalAgents: defaultExternalAgents(),
        roundLimit: 16,
        proxyToolTimeoutMs: 30_000,
      },
      secureKeys: ["apiKey"],
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(4, "plugin:kuku-ai|ai_set_config", {
      config: {
        provider: "remote",
        apiKey: null,
        model: "gemini-3.1-flash-lite",
        serverUrl: "http://localhost:8080",
        externalAgents: defaultExternalAgents(),
        roundLimit: 16,
        proxyToolTimeoutMs: 30_000,
      },
    });
    expect(chat.chatState.config.provider).toBe("remote");
    expect(chat.chatState.config.model).toBe("gemini-3.1-flash-lite");
    expect(chat.chatState.config.serverUrl).toBe("http://localhost:8080");
  });

  it("passes stale secure external agent env keys during load-time config normalization", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin_get_settings":
        case "plugin_get_settings_with_secrets":
          return {
            provider: "remote",
            apiKey: null,
            model: "gemini-3.1-flash-lite",
            serverUrl: "https://old",
            externalAgents: [
              {
                id: "custom-acp",
                label: "Custom ACP",
                command: "node",
                args: [],
                env: {},
                enabled: true,
              },
            ],
            __secure: {
              "externalAgentEnv.custom-acp.API_TOKEN": {
                storage: "keyring",
                present: true,
                version: 1,
              },
            },
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

    expect(mockInvoke).toHaveBeenCalledWith(
      "plugin_save_settings_with_secrets",
      expect.objectContaining({
        secureKeys: ["apiKey", "externalAgentEnv.custom-acp.API_TOKEN"],
      }),
    );
  });

  it("pins saved plugin settings to the build default model before syncing runtime config", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin_get_settings":
          return {};
        case "plugin_save_settings_with_secrets":
        case "plugin:kuku-ai|ai_set_config":
          return undefined;
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();

    await chat.saveConfig("remote", "", "https://saved");

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "plugin_get_settings", {
      pluginId: "ai-chat",
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "plugin_save_settings_with_secrets", {
      pluginId: "ai-chat",
      settings: {
        provider: "remote",
        apiKey: null,
        model: "gemini-3.1-flash-lite",
        serverUrl: "https://saved",
        externalAgents: defaultExternalAgents(),
        roundLimit: 12,
        proxyToolTimeoutMs: 15_000,
      },
      secureKeys: ["apiKey"],
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "plugin:kuku-ai|ai_set_config", {
      config: {
        provider: "remote",
        apiKey: null,
        model: "gemini-3.1-flash-lite",
        serverUrl: "https://saved",
        externalAgents: defaultExternalAgents(),
        roundLimit: 12,
        proxyToolTimeoutMs: 15_000,
      },
    });
  });

  it("persists edited Codex ACP env and secures sensitive keys", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin_get_settings":
          return {};
        case "plugin_save_settings_with_secrets":
        case "plugin:kuku-ai|ai_set_config":
          return undefined;
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();

    chat.setExternalAgents([
      {
        id: "codex-acp",
        label: "Codex CLI",
        command: "node",
        args: ["agent.js"],
        env: {
          OPENAI_API_KEY: "secret-token",
          PATH: "/usr/bin",
        },
        enabled: true,
      },
    ]);
    await chat.saveConfig("remote", "", "https://saved");

    expect(mockInvoke).toHaveBeenNthCalledWith(2, "plugin_save_settings_with_secrets", {
      pluginId: "ai-chat",
      settings: {
        provider: "remote",
        apiKey: null,
        model: "gemini-3.1-flash-lite",
        serverUrl: "https://saved",
        externalAgents: [
          {
            id: "codex-acp",
            label: "Codex CLI",
            command: "npx",
            args: ["-y", "@zed-industries/codex-acp@latest"],
            env: {
              OPENAI_API_KEY: "••••••••",
              PATH: "/usr/bin",
            },
            enabled: true,
          },
        ],
        "externalAgentEnv.codex-acp.OPENAI_API_KEY": "secret-token",
        roundLimit: 12,
        proxyToolTimeoutMs: 15_000,
      },
      secureKeys: ["apiKey", "externalAgentEnv.codex-acp.OPENAI_API_KEY"],
    });
  });

  it("passes stale secure external agent env keys on save so removed secrets are deleted", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin_get_settings":
          return {
            externalAgents: [
              {
                id: "custom-acp",
                label: "Custom ACP",
                command: "node",
                args: ["agent.js"],
                env: {},
                enabled: true,
              },
            ],
            __secure: {
              "externalAgentEnv.custom-acp.API_TOKEN": {
                storage: "keyring",
                present: true,
                version: 1,
              },
            },
          };
        case "plugin_save_settings_with_secrets":
        case "plugin:kuku-ai|ai_set_config":
          return undefined;
        case "plugin:kuku-ai|ai_list_agents":
          return [];
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();
    chat.setExternalAgents([
      {
        id: "custom-acp",
        label: "Custom ACP",
        command: "node",
        args: ["agent.js"],
        env: {},
        enabled: true,
      },
    ]);
    await chat.saveConfig("remote", "", "https://saved");

    expect(mockInvoke).toHaveBeenCalledWith(
      "plugin_save_settings_with_secrets",
      expect.objectContaining({
        secureKeys: ["apiKey", "externalAgentEnv.custom-acp.API_TOKEN"],
      }),
    );
  });

  it("clears persisted secure settings through secure-aware command", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin_get_settings":
          return {
            externalAgents: [
              {
                id: "codex-acp",
                label: "Codex CLI",
                command: "npx",
                args: [],
                env: {
                  OPENAI_API_KEY: "••••••••",
                },
                enabled: true,
              },
            ],
          };
        case "plugin_clear_settings_with_secrets":
          return undefined;
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();

    await chat.clearPersistedConfig();

    expect(mockInvoke).toHaveBeenCalledWith("plugin_clear_settings_with_secrets", {
      pluginId: "ai-chat",
      secureKeys: ["apiKey", "externalAgentEnv.codex-acp.OPENAI_API_KEY"],
    });
  });

  it("refreshes visible agents after saving external agent settings", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin_get_settings":
          return {};
        case "plugin_save_settings_with_secrets":
        case "plugin:kuku-ai|ai_set_config":
          return undefined;
        case "plugin:kuku-ai|ai_list_agents":
          return [
            {
              id: "kuku-native",
              label: "Kuku Agent",
              kind: "native",
              enabled: true,
              managed: true,
            },
            {
              id: "codex-acp",
              label: "Codex CLI",
              kind: "acp",
              enabled: true,
              managed: true,
            },
          ];
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();
    chat.setExternalAgents([
      {
        id: "codex-acp",
        label: "Codex CLI",
        command: "npx",
        args: ["-y", "@zed-industries/codex-acp@latest"],
        env: {},
        enabled: true,
      },
    ]);

    await chat.saveConfig("remote", "", "https://saved");

    expect(chat.setSelectedAgent("codex-acp")).toBe(true);
  });
});

describe("ai_chat chat_store session modes", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockReadVaultFileWithChecksum.mockReset();
    mockContextSnapshot.mockReset();
    mockGetCurrentVault.mockReset();
    mockGetCurrentVault.mockResolvedValue(null);
    mockContextSnapshot.mockImplementation(defaultEditorContext);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: new StorageMock(),
    });
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
    expect(chat.chatState.sessions["session-1"]?.agentId).toBe("kuku-native");
    expect(chat.chatState.selectedMode).toBe("agent");
    expect(chat.chatState.sessions["session-1"]?.mode).toBe("agent");
    expect(chat.chatState.sessions["session-1"]?.draft).toBe("keep this draft");
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("plugin:kuku-ai|ai_new_session", {
      agentId: "kuku-native",
      mode: "ask",
    });
  });

  it("defaults sessions created through ensureSession to the native agent", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_new_session":
          return { sessionId: "session-1" };
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();

    const sessionId = await chat.ensureSession();

    expect(sessionId).toBe("session-1");
    expect(chat.chatState.sessions["session-1"]?.agentId).toBe("kuku-native");
  });

  it("uses the active vault root as the agent working directory", async () => {
    mockGetCurrentVault.mockResolvedValue("/Users/me/Notes");
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

    expect(mockInvoke).toHaveBeenCalledWith("plugin:kuku-ai|ai_new_session", {
      agentId: "kuku-native",
      mode: "ask",
      workingDirectory: "/Users/me/Notes",
    });
  });

  it("uses the active vault root when restoring an agent session", async () => {
    mockGetCurrentVault.mockResolvedValue("/Users/me/Notes");
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_list_sessions":
          return [
            {
              localSessionId: "persisted-1",
              externalSessionId: "external-1",
              agentId: "codex-acp",
              title: "Summarize workspace",
              updatedAtMs: 1_700_000,
              supportsLoad: false,
              supportsResume: true,
              workingDirectory: "/Users/me/Notes",
            },
          ];
        case "plugin:kuku-ai|ai_restore_session":
          return { sessionId: "persisted-1" };
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();
    await chat.loadSessions();
    expect(chat.switchSession("persisted-1")).toBe(true);

    await chat.ensureSession();

    expect(mockInvoke).toHaveBeenCalledWith("plugin:kuku-ai|ai_restore_session", {
      agentId: "codex-acp",
      sessionId: "persisted-1",
      externalSessionId: "external-1",
      mode: "ask",
      messages: [],
      workingDirectory: "/Users/me/Notes",
    });
  });

  it("closes the active session and switches to the newest remaining session", async () => {
    let nextSession = 1;
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_new_session":
          return { sessionId: `session-${nextSession++}` };
        case "plugin:kuku-ai|ai_close_session":
          return undefined;
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();

    await chat.createSession("ask");
    await chat.createSession("agent");

    expect(chat.chatState.activeSessionId).toBe("session-2");

    await expect(chat.closeSession()).resolves.toBe(true);

    expect(mockInvoke).toHaveBeenLastCalledWith("plugin:kuku-ai|ai_close_session", {
      agentId: "kuku-native",
      sessionId: "session-2",
    });
    expect(chat.chatState.sessions["session-2"]).toBeUndefined();
    expect(chat.chatState.activeSessionId).toBe("session-1");
    expect(chat.chatState.selectedMode).toBe("ask");
  });

  it("closes the only active session and leaves the composer ready to create the next one", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_new_session":
          return { sessionId: "session-1" };
        case "plugin:kuku-ai|ai_close_session":
          return undefined;
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();

    await chat.createSession("ask");
    await expect(chat.closeSession()).resolves.toBe(true);

    expect(chat.chatState.sessions["session-1"]).toBeUndefined();
    expect(chat.chatState.activeSessionId).toBeNull();
    expect(chat.chatState.selectedMode).toBe("ask");
  });

  it("loads persisted session metadata into thread summaries", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_list_sessions":
          return [
            {
              localSessionId: "persisted-1",
              externalSessionId: "external-1",
              agentId: "codex-acp",
              title: "Summarize workspace",
              updatedAtMs: 1_700_000,
              supportsLoad: false,
              supportsResume: true,
            },
          ];
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();

    await chat.loadSessions();

    expect(chat.chatState.sessions["persisted-1"]).toMatchObject({
      id: "persisted-1",
      externalSessionId: "external-1",
      agentId: "codex-acp",
      persistedTitle: "Summarize workspace",
      supportsLoad: false,
      supportsResume: true,
    });
    expect(chat.getSessionSummaries()[0]).toMatchObject({
      id: "persisted-1",
      agentId: "codex-acp",
      title: "Summarize workspace",
    });
  });

  it("restores locally saved session messages after app restart", async () => {
    localStorage.setItem(
      scopedChatSessionsStorageKey(null),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            id: "persisted-1",
            externalSessionId: "external-1",
            agentId: "codex-acp",
            mode: "ask",
            createdAt: 1_699_999,
            updatedAt: 1_700_001,
            persistedTitle: "Summarize workspace",
            supportsLoad: false,
            supportsResume: true,
            draft: "follow up",
            autoApprove: true,
            messages: [
              {
                id: "message-1",
                kind: "text",
                role: "user",
                content: "remember this",
              },
            ],
          },
        ],
      }),
    );
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_list_sessions":
          return [
            {
              localSessionId: "persisted-1",
              externalSessionId: "external-1",
              agentId: "codex-acp",
              title: "Summarize workspace",
              updatedAtMs: 1_700_000,
              supportsLoad: false,
              supportsResume: true,
            },
          ];
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();

    await chat.loadSessions();

    expect(chat.chatState.activeSessionId).toBe("persisted-1");
    expect(chat.chatState.selectedAgentId).toBe("codex-acp");
    expect(chat.chatState.sessions["persisted-1"]).toMatchObject({
      id: "persisted-1",
      draft: "follow up",
      autoApprove: true,
      messages: [
        {
          id: "message-1",
          kind: "text",
          role: "user",
          content: "remember this",
        },
      ],
    });
    expect(chat.getSessionSummaries()[0]).toMatchObject({
      id: "persisted-1",
      messageCount: 1,
      isActive: true,
      title: "remember this",
    });
  });

  it("restores session messages from the backend chat session store", async () => {
    mockGetCurrentVault.mockResolvedValue("/Users/me/Notes");
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_list_chat_sessions":
          return [
            {
              id: "persisted-1",
              externalSessionId: "external-1",
              agentId: "codex-acp",
              mode: "ask",
              createdAt: 1_699_999,
              updatedAt: 1_700_001,
              persistedTitle: "Summarize workspace",
              supportsLoad: false,
              supportsResume: true,
              workingDirectory: "/Users/me/Notes",
              draft: "follow up",
              autoApprove: true,
              messages: [
                {
                  id: "message-1",
                  kind: "text",
                  role: "user",
                  content: "remember this",
                },
              ],
            },
          ];
        case "plugin:kuku-ai|ai_list_sessions":
          return [
            {
              localSessionId: "persisted-1",
              externalSessionId: "external-1",
              agentId: "codex-acp",
              title: "Summarize workspace",
              updatedAtMs: 1_700_000,
              supportsLoad: false,
              supportsResume: true,
              workingDirectory: "/Users/me/Notes",
            },
          ];
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();

    await chat.loadSessions();

    expect(mockInvoke).toHaveBeenCalledWith("plugin:kuku-ai|ai_list_chat_sessions", {
      workingDirectory: "/Users/me/Notes",
    });
    expect(localStorage.getItem(scopedChatSessionsStorageKey("/Users/me/Notes"))).toBeNull();
    expect(chat.chatState.activeSessionId).toBe("persisted-1");
    expect(chat.chatState.sessions["persisted-1"]).toMatchObject({
      id: "persisted-1",
      draft: "follow up",
      autoApprove: true,
      messages: [
        {
          id: "message-1",
          kind: "text",
          role: "user",
          content: "remember this",
        },
      ],
    });
  });

  it("loads locally saved sessions only for the active vault", async () => {
    mockGetCurrentVault.mockResolvedValue("/Users/me/Vault A");
    localStorage.setItem(
      CHAT_SESSIONS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        sessions: [
          {
            id: "legacy-global",
            agentId: "kuku-native",
            mode: "ask",
            createdAt: 1,
            updatedAt: 1,
            draft: "",
            autoApprove: false,
            messages: [
              {
                id: "legacy-message",
                kind: "text",
                role: "user",
                content: "wrong vault",
              },
            ],
          },
        ],
      }),
    );
    localStorage.setItem(
      scopedChatSessionsStorageKey("/Users/me/Vault A"),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            id: "vault-a-session",
            agentId: "kuku-native",
            mode: "ask",
            createdAt: 2,
            updatedAt: 2,
            draft: "vault draft",
            autoApprove: false,
            messages: [
              {
                id: "vault-message",
                kind: "text",
                role: "user",
                content: "right vault",
              },
            ],
          },
        ],
      }),
    );
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_list_sessions":
          return [];
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();

    await chat.loadSessions();

    expect(mockInvoke).toHaveBeenCalledWith("plugin:kuku-ai|ai_list_sessions", {
      workingDirectory: "/Users/me/Vault A",
    });
    expect(chat.chatState.sessions["vault-a-session"]).toMatchObject({
      id: "vault-a-session",
      draft: "vault draft",
    });
    expect(chat.chatState.sessions["legacy-global"]).toBeUndefined();
    expect(chat.chatState.activeSessionId).toBe("vault-a-session");
  });

  it("ignores backend sessions that do not belong to the active vault", async () => {
    mockGetCurrentVault.mockResolvedValue("/Users/me/Vault A");
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_list_sessions":
          return [
            {
              localSessionId: "vault-a-session",
              externalSessionId: null,
              agentId: "kuku-native",
              title: "Vault A",
              updatedAtMs: 30,
              supportsLoad: false,
              supportsResume: false,
              workingDirectory: "/Users/me/Vault A",
            },
            {
              localSessionId: "vault-b-session",
              externalSessionId: null,
              agentId: "kuku-native",
              title: "Vault B",
              updatedAtMs: 40,
              supportsLoad: false,
              supportsResume: false,
              workingDirectory: "/Users/me/Vault B",
            },
            {
              localSessionId: "legacy-global-session",
              externalSessionId: null,
              agentId: "kuku-native",
              title: "Legacy global",
              updatedAtMs: 50,
              supportsLoad: false,
              supportsResume: false,
            },
          ];
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();

    await chat.loadSessions();

    expect(chat.getSessionSummaries()).toMatchObject([
      {
        id: "vault-a-session",
        title: "Vault A",
      },
    ]);
    expect(chat.chatState.sessions["vault-b-session"]).toBeUndefined();
    expect(chat.chatState.sessions["legacy-global-session"]).toBeUndefined();
  });

  it("hides already-mounted sessions that are outside the active vault", async () => {
    mockGetCurrentVault.mockResolvedValue("/Users/me/Vault A");
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_new_session":
          return { sessionId: "vault-a-session" };
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();
    chat.resetToSession("legacy-global-session", "ask");

    await chat.createSession("ask");

    expect(chat.chatState.sessions["legacy-global-session"]).toBeDefined();
    expect(chat.getSessionSummaries()).toMatchObject([
      {
        id: "vault-a-session",
      },
    ]);
  });

  it("persists sent messages for the next app launch", async () => {
    mockGetCurrentVault.mockResolvedValue("/Users/me/Notes");
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_new_session":
          return { sessionId: "session-1" };
        case "plugin:kuku-ai|ai_send_message":
          return undefined;
        case "plugin:kuku-ai|ai_save_chat_sessions":
          return undefined;
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();

    await expect(chat.sendMessage("remember this")).resolves.toBe(true);

    expect(localStorage.getItem(CHAT_SESSIONS_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(scopedChatSessionsStorageKey("/Users/me/Notes"))).toBeNull();
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("plugin:kuku-ai|ai_save_chat_sessions", {
        workingDirectory: "/Users/me/Notes",
        sessions: [
          expect.objectContaining({
            id: "session-1",
            agentId: "kuku-native",
            mode: "ask",
            draft: "",
            autoApprove: false,
            messages: [
              expect.objectContaining({
                kind: "text",
                role: "user",
                content: "remember this",
              }),
            ],
          }),
        ],
      });
    });
  });

  it("reconnects a restored persisted session before sending from it", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_list_sessions":
          return [
            {
              localSessionId: "persisted-1",
              externalSessionId: "external-1",
              agentId: "codex-acp",
              title: "Summarize workspace",
              updatedAtMs: 1_700_000,
              supportsLoad: false,
              supportsResume: true,
            },
          ];
        case "plugin:kuku-ai|ai_restore_session":
          return { sessionId: "persisted-1" };
        case "plugin:kuku-ai|ai_send_message":
          return undefined;
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();
    await chat.loadSessions();
    expect(chat.switchSession("persisted-1")).toBe(true);

    await expect(chat.sendMessage("hello")).resolves.toBe(true);

    expect(mockInvoke).not.toHaveBeenCalledWith("plugin:kuku-ai|ai_new_session", expect.anything());
    expect(mockInvoke).toHaveBeenCalledWith("plugin:kuku-ai|ai_restore_session", {
      agentId: "codex-acp",
      sessionId: "persisted-1",
      externalSessionId: "external-1",
      mode: "ask",
      messages: [],
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      "plugin:kuku-ai|ai_send_message",
      expect.objectContaining({
        sessionId: "persisted-1",
        agentId: "codex-acp",
      }),
    );
    expect(chat.chatState.activeSessionId).toBe("persisted-1");
    expect(chat.chatState.sessions["persisted-1"]?.restored).toBe(false);
    expect(chat.chatState.sessions["persisted-1"]?.messages).toMatchObject([
      {
        kind: "text",
        role: "user",
        content: "hello",
      },
    ]);
  });

  it("starts a fresh ACP session when a restored legacy session has no external id", async () => {
    mockGetCurrentVault.mockResolvedValue("/Users/me/Notes");
    localStorage.setItem(
      scopedChatSessionsStorageKey("/Users/me/Notes"),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            id: "legacy-acp-session",
            externalSessionId: null,
            agentId: "codex-acp",
            mode: "ask",
            createdAt: 1_699_999,
            updatedAt: 1_700_001,
            persistedTitle: "Legacy Codex session",
            supportsLoad: true,
            supportsResume: true,
            draft: "",
            autoApprove: false,
            messages: [
              {
                id: "message-1",
                kind: "text",
                role: "user",
                content: "old prompt",
              },
            ],
          },
        ],
      }),
    );
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_list_sessions":
          return [];
        case "plugin:kuku-ai|ai_new_session":
          return { sessionId: "fresh-acp-session" };
        case "plugin:kuku-ai|ai_send_message":
          return undefined;
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();
    await chat.loadSessions();

    expect(chat.switchSession("legacy-acp-session")).toBe(true);
    await expect(chat.sendMessage("continue here")).resolves.toBe(true);

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "plugin:kuku-ai|ai_restore_session",
      expect.anything(),
    );
    expect(mockInvoke).toHaveBeenCalledWith("plugin:kuku-ai|ai_new_session", {
      agentId: "codex-acp",
      mode: "ask",
      workingDirectory: "/Users/me/Notes",
    });
    const sendCall = mockInvoke.mock.calls.find(
      ([command]) => command === "plugin:kuku-ai|ai_send_message",
    );
    expect(sendCall?.[1]).toMatchObject({
      agentId: "codex-acp",
      sessionId: "fresh-acp-session",
    });
    expect(sendCall?.[1].content).toContain("<previous_transcript>");
    expect(sendCall?.[1].content).toContain("USER: old prompt");
    expect(sendCall?.[1].content).toContain("continue here");
    expect(chat.chatState.sessions["legacy-acp-session"]?.error).toBeNull();
    expect(chat.chatState.activeSessionId).toBe("fresh-acp-session");
    expect(chat.chatState.sessions["fresh-acp-session"]?.messages).toMatchObject([
      {
        kind: "text",
        role: "user",
        content: "old prompt",
      },
      {
        kind: "text",
        role: "user",
        content: "continue here",
      },
    ]);
  });

  it("exposes the builtin catalog and enables Codex only after loading backend availability", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_list_agents":
          return [
            {
              id: "kuku-native",
              label: "Kuku Agent",
              kind: "native",
              enabled: true,
              managed: true,
            },
            {
              id: "codex-acp",
              label: "Codex CLI",
              kind: "acp",
              enabled: true,
              managed: true,
            },
          ];
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });
    const chat = await loadChatStoreModule();

    expect(chat.chatState.selectedAgentId).toBe("kuku-native");
    expect(chat.chatState.agents.map((agent) => agent.id)).toEqual(["kuku-native", "codex-acp"]);

    expect(chat.setSelectedAgent("codex-acp")).toBe(false);
    await chat.loadAgents();
    expect(chat.setSelectedAgent("codex-acp")).toBe(true);
    expect(chat.setSelectedAgent("missing-agent")).toBe(false);
    expect(chat.setSelectedAgent("claude-acp")).toBe(false);
    expect(chat.setSelectedAgent("gemini-acp")).toBe(false);
    expect(chat.chatState.selectedAgentId).toBe("codex-acp");
  });

  it("uses the selected enabled agent for future idle sessions", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_new_session":
          return { sessionId: mockInvoke.mock.calls.length === 1 ? "session-1" : "session-2" };
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();
    chat.setChatAgents(enabledCodexAgents());

    await chat.createSession("ask");

    expect(chat.setSelectedAgent("codex-acp")).toBe(true);
    expect(chat.chatState.activeSessionId).toBeNull();

    const sessionId = await chat.ensureSession();

    expect(sessionId).toBe("session-2");
    expect(chat.chatState.sessions["session-2"]?.agentId).toBe("codex-acp");
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "plugin:kuku-ai|ai_new_session", {
      agentId: "codex-acp",
      mode: "ask",
    });
  });

  it("creates a new session with an explicitly chosen agent", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_new_session":
          return { sessionId: "session-1" };
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();
    chat.setChatAgents(enabledCodexAgents());

    const sessionId = await chat.createSession("ask", "codex-acp");

    expect(sessionId).toBe("session-1");
    expect(chat.chatState.sessions["session-1"]?.agentId).toBe("codex-acp");
    expect(chat.chatState.selectedAgentId).toBe("codex-acp");
    expect(mockInvoke).toHaveBeenCalledWith("plugin:kuku-ai|ai_new_session", {
      agentId: "codex-acp",
      mode: "ask",
    });
  });

  it("records a new session under the agent selected when creation started", async () => {
    let resolveNewSession: (payload: { sessionId: string }) => void = () => {};
    const newSessionPromise = new Promise<{ sessionId: string }>((resolve) => {
      resolveNewSession = resolve;
    });
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_new_session":
          return newSessionPromise;
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();
    chat.setChatAgents(enabledCodexAgents());

    const createSessionPromise = chat.createSession("ask");
    await Promise.resolve();
    expect(mockInvoke).toHaveBeenCalledWith("plugin:kuku-ai|ai_new_session", {
      agentId: "kuku-native",
      mode: "ask",
    });

    expect(chat.setSelectedAgent("codex-acp")).toBe(true);
    resolveNewSession({ sessionId: "session-1" });

    await expect(createSessionPromise).resolves.toBe("session-1");
    expect(chat.chatState.sessions["session-1"]?.agentId).toBe("kuku-native");
    expect(chat.chatState.activeSessionId).toBe("session-1");
    expect(chat.chatState.selectedAgentId).toBe("kuku-native");
  });

  it("keeps a busy active session mounted when selecting another enabled agent", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_new_session":
          return { sessionId: "session-1" };
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();
    chat.setChatAgents(enabledCodexAgents());

    await chat.createSession("ask");
    chat.setSessionStatus("session-1", "streaming");

    expect(chat.setSelectedAgent("codex-acp")).toBe(true);
    expect(chat.chatState.selectedAgentId).toBe("codex-acp");
    expect(chat.chatState.activeSessionId).toBe("session-1");
    expect(chat.chatState.sessions["session-1"]?.agentId).toBe("kuku-native");
  });

  it("clears a finished active session whose agent no longer matches the selected agent", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_new_session":
          return { sessionId: mockInvoke.mock.calls.length === 1 ? "session-1" : "session-2" };
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();
    chat.setChatAgents(enabledCodexAgents());

    await chat.createSession("ask");
    chat.setSessionStatus("session-1", "streaming");
    chat.setSelectedAgent("codex-acp");
    chat.finishSession("session-1", { sessionId: "session-1", finishReason: "stop" });

    const sessionId = await chat.ensureSession();

    expect(sessionId).toBe("session-2");
    expect(chat.chatState.activeSessionId).toBe("session-2");
    expect(chat.chatState.sessions["session-2"]?.agentId).toBe("codex-acp");
  });

  it("clears an idle active session when its selected agent disappears from the catalog", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_new_session":
          return { sessionId: mockInvoke.mock.calls.length === 1 ? "session-1" : "session-2" };
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();
    const builtinAgents = [...chat.chatState.agents];
    chat.setChatAgents(enabledCodexAgents());

    expect(chat.setSelectedAgent("codex-acp")).toBe(true);
    await chat.createSession("ask");

    expect(chat.chatState.activeSessionId).toBe("session-1");
    expect(chat.chatState.sessions["session-1"]?.agentId).toBe("codex-acp");

    chat.setChatAgents(builtinAgents);

    expect(chat.chatState.selectedAgentId).toBe("kuku-native");
    expect(chat.chatState.activeSessionId).toBeNull();

    const sessionId = await chat.ensureSession();

    expect(sessionId).toBe("session-2");
    expect(chat.chatState.sessions["session-2"]?.agentId).toBe("kuku-native");
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
      agentId: "kuku-native",
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

  it("shows asynchronous session errors as system messages", async () => {
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
    chat.setError("session-1", {
      sessionId: "session-1",
      message: "ACP agent exited after responding",
    });

    expect(chat.chatState.sessions["session-1"]?.messages).toMatchObject([
      {
        kind: "text",
        role: "system",
        content: "ACP agent exited after responding",
      },
    ]);
  });

  it("starts a fresh session when sending after an error state", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_new_session":
          return { sessionId: mockInvoke.mock.calls.length === 1 ? "session-1" : "session-2" };
        case "plugin:kuku-ai|ai_send_message":
          return undefined;
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();

    await chat.createSession("ask");
    chat.setError("session-1", {
      sessionId: "session-1",
      message: "ACP session closed",
    });

    await expect(chat.sendMessage("try again")).resolves.toBe(true);

    expect(chat.chatState.activeSessionId).toBe("session-2");
    expect(chat.chatState.sessions["session-2"]?.messages).toMatchObject([
      {
        kind: "text",
        role: "user",
        content: "try again",
      },
    ]);
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "plugin:kuku-ai|ai_send_message", {
      agentId: "kuku-native",
      sessionId: "session-2",
      mode: "ask",
      content: "try again",
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
      agentId: "kuku-native",
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
      agentId: "kuku-native",
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
      agentId: "kuku-native",
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

  it("sends messages and cancellation to the active session agent", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin:kuku-ai|ai_new_session":
          return { sessionId: mockInvoke.mock.calls.length === 1 ? "session-1" : "session-2" };
        case "plugin:kuku-ai|ai_send_message":
        case "plugin:kuku-ai|ai_cancel":
          return undefined;
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const chat = await loadChatStoreModule();
    chat.setChatAgents(enabledCodexAgents());

    expect(chat.setSelectedAgent("codex-acp")).toBe(true);
    await chat.createSession("ask");

    await chat.sendMessage("use the session owner");
    await chat.cancelSession();

    expect(mockInvoke).toHaveBeenNthCalledWith(2, "plugin:kuku-ai|ai_send_message", {
      agentId: "codex-acp",
      sessionId: "session-1",
      mode: "ask",
      content: "use the session owner",
      editorContext: {
        activeFile: null,
        selectedText: null,
        openTabs: [],
        cursorLine: null,
        embeddedFiles: [],
      },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "plugin:kuku-ai|ai_cancel", {
      agentId: "codex-acp",
      sessionId: "session-1",
    });
  });

  it("tracks the selected permission preset without changing chat mode", async () => {
    const chat = await loadChatStoreModule();

    expect(chat.chatState.permissionPreset).toBe("default");

    chat.setPermissionPreset("auto-review");

    expect(chat.chatState.permissionPreset).toBe("auto-review");
    expect(chat.chatState.selectedMode).toBe("ask");
  });

  it("summarizes sessions and switches the active session with its mode", async () => {
    mockInvoke.mockImplementation(async (command: string, payload?: { content?: string }) => {
      switch (command) {
        case "plugin:kuku-ai|ai_new_session":
          return { sessionId: mockInvoke.mock.calls.length === 1 ? "session-1" : "session-2" };
        case "plugin:kuku-ai|ai_send_message":
          return undefined;
        default:
          throw new Error(`unexpected invoke: ${command} ${payload?.content ?? ""}`);
      }
    });

    const chat = await loadChatStoreModule();

    await chat.createSession("ask");
    await chat.sendMessage("Summarize the current note");
    chat.finishSession("session-1", { sessionId: "session-1", finishReason: "stop" });

    await chat.createSession("agent");
    chat.setDraft("continue later");

    expect(chat.getSessionSummaries()).toMatchObject([
      {
        id: "session-2",
        agentId: "kuku-native",
        mode: "agent",
        title: "Agent session",
        draft: "continue later",
        messageCount: 0,
        isActive: true,
      },
      {
        id: "session-1",
        agentId: "kuku-native",
        mode: "ask",
        title: "Summarize the current note",
        draft: "",
        messageCount: 1,
        isActive: false,
      },
    ]);

    expect(chat.switchSession("session-1")).toBe(true);

    expect(chat.chatState.activeSessionId).toBe("session-1");
    expect(chat.chatState.selectedMode).toBe("ask");
    expect(chat.getSessionSummaries()[1]).toMatchObject({
      id: "session-2",
      isActive: false,
      draft: "continue later",
    });
  });

  it("does not switch to a missing session", async () => {
    const chat = await loadChatStoreModule();

    expect(chat.switchSession("missing-session")).toBe(false);
    expect(chat.chatState.activeSessionId).toBeNull();
  });
});
