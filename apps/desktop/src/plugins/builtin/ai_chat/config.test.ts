import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXTERNAL_AGENTS,
  aiChatSecureKeysForConfig,
  aiChatSecureKeysForRawSettings,
  aiChatSecureKeysForSave,
  externalAgentConfigsEqual,
  hasAiSettingsChanges,
  hydrateAiConfigExternalSecrets,
  normalizeAiConfig,
  prepareAiConfigForSave,
  redactedExternalAgentConfig,
} from "./config";

describe("ai_chat config external agents", () => {
  it("keeps only Codex ACP settings from persisted plugin config", () => {
    const config = normalizeAiConfig({
      externalAgents: [
        {
          id: "custom-acp",
          label: " Custom ACP ",
          command: " node ",
          args: ["agent.js", 3, " --stdio "],
          env: {
            PATH: "/usr/bin",
            API_TOKEN: "secret-token",
            EMPTY: "",
            BAD: 10,
          },
          enabled: true,
        },
        {
          id: "codex-acp",
          label: " Renamed Codex ",
          command: "node",
          args: ["agent.js"],
          env: {
            OPENAI_API_KEY: "sk-test",
            PATH: "/usr/bin",
          },
          enabled: false,
        },
      ],
    });

    expect(config.externalAgents).toEqual([
      {
        id: "codex-acp",
        label: "Codex CLI",
        command: "npx",
        args: ["-y", "@zed-industries/codex-acp@latest"],
        env: {
          OPENAI_API_KEY: "sk-test",
          PATH: "/usr/bin",
        },
        enabled: true,
      },
    ]);
  });

  it("keeps managed defaults when no external agents are persisted", () => {
    const config = normalizeAiConfig({});

    expect(config.externalAgents).toEqual(DEFAULT_EXTERNAL_AGENTS);
    expect(config.externalAgents).toHaveLength(1);
    expect(config.externalAgents?.[0]?.id).toBe("codex-acp");
  });

  it("compares external agent settings by normalized value", () => {
    const [agent] = DEFAULT_EXTERNAL_AGENTS;

    expect(externalAgentConfigsEqual([agent], [{ ...agent, args: [...agent.args] }])).toBe(true);
    expect(
      hasAiSettingsChanges(
        {
          provider: "remote",
          apiKey: "",
          serverUrl: "http://localhost:8080",
          externalAgents: [{ ...agent, enabled: false }],
        },
        {
          provider: "remote",
          apiKey: null,
          serverUrl: "http://localhost:8080",
          externalAgents: [agent],
        },
      ),
    ).toBe(false);
  });

  it("marks external agent env edits as unsaved settings changes", () => {
    const config = normalizeAiConfig({});

    expect(
      hasAiSettingsChanges(
        {
          provider: config.provider ?? "remote",
          apiKey: config.apiKey ?? "",
          serverUrl: config.serverUrl ?? "",
          externalAgents: [{ ...DEFAULT_EXTERNAL_AGENTS[0], env: { PATH: "/usr/bin" } }],
        },
        config,
      ),
    ).toBe(true);
  });

  it("derives secure plugin keys for sensitive external agent env values", () => {
    const config = normalizeAiConfig({
      externalAgents: [
        {
          id: "codex-acp",
          label: "Codex CLI",
          command: "npx",
          args: ["-y", "@zed-industries/codex-acp@latest"],
          env: {
            OPENAI_API_KEY: "sk-test",
            PATH: "/usr/bin",
            session_token: "abc",
          },
          enabled: true,
        },
      ],
    });

    expect(aiChatSecureKeysForConfig(config)).toEqual([
      "apiKey",
      "externalAgentEnv.codex-acp.OPENAI_API_KEY",
      "externalAgentEnv.codex-acp.session_token",
    ]);
  });

  it("treats PAT-style env names as sensitive without classifying PATH", () => {
    const config = normalizeAiConfig({
      externalAgents: [
        {
          id: "codex-acp",
          label: "Codex CLI",
          command: "npx",
          args: [],
          env: {
            GITHUB_PAT: "github-secret",
            PATH: "/usr/bin",
          },
          enabled: true,
        },
      ],
    });

    expect(aiChatSecureKeysForConfig(config)).toEqual([
      "apiKey",
      "externalAgentEnv.codex-acp.GITHUB_PAT",
    ]);
    expect(redactedExternalAgentConfig(config.externalAgents ?? [])[0]?.env).toEqual({
      GITHUB_PAT: "••••••••",
      PATH: "/usr/bin",
    });
  });

  it("redacts sensitive external agent env values for display", () => {
    const [agent] = redactedExternalAgentConfig([
      {
        id: "codex-acp",
        label: "Codex CLI",
        command: "npx",
        args: [],
        env: {
          OPENAI_API_KEY: "sk-test",
          PATH: "/usr/bin",
        },
        enabled: true,
      },
    ]);

    expect(agent?.env).toEqual({
      OPENAI_API_KEY: "••••••••",
      PATH: "/usr/bin",
    });
  });

  it("moves sensitive external agent env values to top-level secure fields before save", () => {
    const config = normalizeAiConfig({
      externalAgents: [
        {
          id: "codex-acp",
          label: "Codex CLI",
          command: "npx",
          args: [],
          env: {
            OPENAI_API_KEY: "sk-test",
            PATH: "/usr/bin",
          },
          enabled: true,
        },
      ],
    });

    expect(prepareAiConfigForSave(config)).toMatchObject({
      externalAgents: [
        {
          env: {
            OPENAI_API_KEY: "••••••••",
            PATH: "/usr/bin",
          },
        },
      ],
      "externalAgentEnv.codex-acp.OPENAI_API_KEY": "sk-test",
    });
  });

  it("discovers and hydrates sensitive external agent env values from secure fields", () => {
    const raw = {
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
      "externalAgentEnv.codex-acp.OPENAI_API_KEY": "sk-test",
    };
    const config = hydrateAiConfigExternalSecrets(normalizeAiConfig(raw), raw);

    expect(aiChatSecureKeysForRawSettings(raw)).toEqual([
      "apiKey",
      "externalAgentEnv.codex-acp.OPENAI_API_KEY",
    ]);
    expect(config.externalAgents?.[0]?.env.OPENAI_API_KEY).toBe("sk-test");
  });

  it("preserves stale secure metadata keys for later deletion", () => {
    const raw = {
      externalAgents: [
        {
          id: "codex-acp",
          label: "Codex CLI",
          command: "npx",
          args: [],
          env: {},
          enabled: true,
        },
      ],
      __secure: {
        "externalAgentEnv.codex-acp.OPENAI_API_KEY": {
          storage: "keyring",
          present: true,
          version: 1,
        },
      },
    };

    expect(aiChatSecureKeysForRawSettings(raw)).toEqual([
      "apiKey",
      "externalAgentEnv.codex-acp.OPENAI_API_KEY",
    ]);
    expect(aiChatSecureKeysForSave(normalizeAiConfig(raw), raw)).toEqual([
      "apiKey",
      "externalAgentEnv.codex-acp.OPENAI_API_KEY",
    ]);
  });
});
