import type { AiConfig, ExternalAgentConfig } from "./types";

const AI_CHAT_SETTINGS_PLUGIN_ID = "ai-chat";
const AI_CHAT_SECURE_KEYS = ["apiKey"] as const;
const REDACTED_ENV_VALUE = "••••••••";
const SECURE_META_STORAGE = "keyring";
const LEGACY_MODEL_ALIASES = new Set(["gemini-3.1-flash-lite-preview"]);
const DEFAULT_MODEL = "gemini-3.1-flash-lite";
const DEFAULT_PROVIDER = "remote" as const;
const DEFAULT_SERVER_URL =
  import.meta.env.VITE_KUKU_API_URL?.trim() ||
  (import.meta.env.PROD ? "https://api.kuku.mom" : "http://localhost:8080");
// Internal guardrails: these are intentionally kept out of the settings UI.
const DEFAULT_ROUND_LIMIT = 12;
const DEFAULT_PROXY_TIMEOUT_MS = 15_000;
const SENSITIVE_ENV_KEY_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|(^|[_-])PAT($|[_-]))/i;
const CODEX_ACP_AGENT_ID = "codex-acp";
const CODEX_ACP_PACKAGE = "@zed-industries/codex-acp@latest";
const CODEX_ACP_COMMAND = "npx";
const CODEX_ACP_ARGS = ["-y", CODEX_ACP_PACKAGE] as const;
const DEFAULT_EXTERNAL_AGENTS: ExternalAgentConfig[] = [
  {
    id: CODEX_ACP_AGENT_ID,
    label: "Codex CLI",
    command: CODEX_ACP_COMMAND,
    args: [...CODEX_ACP_ARGS],
    env: {},
    enabled: true,
  },
];

function createDefaultAiConfig(): AiConfig {
  return {
    provider: DEFAULT_PROVIDER,
    apiKey: null,
    model: DEFAULT_MODEL,
    serverUrl: DEFAULT_SERVER_URL,
    externalAgents: DEFAULT_EXTERNAL_AGENTS.map(cloneExternalAgentConfig),
    roundLimit: DEFAULT_ROUND_LIMIT,
    proxyToolTimeoutMs: DEFAULT_PROXY_TIMEOUT_MS,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAiModel(model: string): string {
  const trimmed = model.trim();
  return LEGACY_MODEL_ALIASES.has(trimmed) ? DEFAULT_MODEL : trimmed;
}

function normalizeAiConfig(raw: unknown): AiConfig {
  const defaults = createDefaultAiConfig();
  if (!isRecord(raw)) return defaults;

  return {
    provider:
      raw.provider === "gemini" || raw.provider === "remote" ? raw.provider : defaults.provider,
    apiKey: typeof raw.apiKey === "string" && raw.apiKey.trim().length > 0 ? raw.apiKey : null,
    model:
      typeof raw.model === "string" && raw.model.trim().length > 0
        ? normalizeAiModel(raw.model)
        : defaults.model,
    serverUrl:
      typeof raw.serverUrl === "string" && raw.serverUrl.trim().length > 0
        ? raw.serverUrl
        : defaults.serverUrl,
    externalAgents: normalizeExternalAgents(raw.externalAgents, defaults.externalAgents ?? []),
    roundLimit:
      typeof raw.roundLimit === "number" && Number.isFinite(raw.roundLimit) && raw.roundLimit > 0
        ? raw.roundLimit
        : defaults.roundLimit,
    proxyToolTimeoutMs:
      typeof raw.proxyToolTimeoutMs === "number" &&
      Number.isFinite(raw.proxyToolTimeoutMs) &&
      raw.proxyToolTimeoutMs > 0
        ? raw.proxyToolTimeoutMs
        : defaults.proxyToolTimeoutMs,
  };
}

function cloneExternalAgentConfig(agent: ExternalAgentConfig): ExternalAgentConfig {
  return {
    id: agent.id,
    label: agent.label,
    command: agent.command,
    args: [...agent.args],
    env: { ...agent.env },
    enabled: agent.enabled,
  };
}

function normalizeExternalAgents(
  raw: unknown,
  defaults: ExternalAgentConfig[],
): ExternalAgentConfig[] {
  if (!Array.isArray(raw)) return defaults.map(cloneExternalAgentConfig);

  const codex = raw.find((value) => isRecord(value) && value.id === CODEX_ACP_AGENT_ID);
  if (!isRecord(codex)) return defaults.map(cloneExternalAgentConfig);

  return [
    {
      ...cloneExternalAgentConfig(defaults[0] ?? DEFAULT_EXTERNAL_AGENTS[0]),
      env: normalizeEnv(codex.env),
      enabled: true,
    },
  ];
}

function normalizeExternalAgentConfigList(
  agents: ExternalAgentConfig[] | undefined,
): ExternalAgentConfig[] {
  return normalizeExternalAgents(agents ?? DEFAULT_EXTERNAL_AGENTS, DEFAULT_EXTERNAL_AGENTS);
}

function normalizeEnv(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, value]) => [key.trim(), value])
      .filter(([key, value]) => key.length > 0 && value.length > 0),
  );
}

function isSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_ENV_KEY_PATTERN.test(key);
}

function externalAgentEnvSecureKey(agentId: string, envKey: string): string {
  return `externalAgentEnv.${agentId}.${envKey}`;
}

function aiChatSecureKeysForConfig(config: AiConfig): string[] {
  const keys = new Set<string>(AI_CHAT_SECURE_KEYS);
  for (const agent of normalizeExternalAgentConfigList(config.externalAgents)) {
    for (const key of Object.keys(agent.env)) {
      if (isSensitiveEnvKey(key)) {
        keys.add(externalAgentEnvSecureKey(agent.id, key));
      }
    }
  }
  return [...keys];
}

function aiChatSecureKeysForRawSettings(raw: unknown): string[] {
  const keys = new Set(aiChatSecureKeysForConfig(normalizeAiConfig(raw)));
  for (const key of secureKeysFromRawMeta(raw)) {
    keys.add(key);
  }
  return [...keys];
}

function aiChatSecureKeysForSave(config: AiConfig, raw: unknown): string[] {
  const keys = new Set(aiChatSecureKeysForRawSettings(raw));
  for (const key of aiChatSecureKeysForConfig(config)) {
    keys.add(key);
  }
  return [...keys];
}

function secureKeysFromRawMeta(raw: unknown): string[] {
  if (!isRecord(raw) || !isRecord(raw.__secure)) return [];
  return Object.entries(raw.__secure)
    .filter(([key, meta]) => {
      if (!key.startsWith("externalAgentEnv.")) return false;
      if (!isRecord(meta)) return false;
      return meta.storage === SECURE_META_STORAGE;
    })
    .map(([key]) => key);
}

function hydrateAiConfigExternalSecrets(config: AiConfig, raw: unknown): AiConfig {
  if (!isRecord(raw)) return config;
  return {
    ...config,
    externalAgents: (config.externalAgents ?? []).map((agent) => ({
      ...agent,
      args: [...agent.args],
      env: Object.fromEntries(
        Object.entries(agent.env).map(([key, value]) => {
          const secureValue = raw[externalAgentEnvSecureKey(agent.id, key)];
          if (isSensitiveEnvKey(key) && typeof secureValue === "string" && secureValue.length > 0) {
            return [key, secureValue];
          }
          return [key, value];
        }),
      ),
    })),
  };
}

function redactedExternalAgentConfig(agents: ExternalAgentConfig[]): ExternalAgentConfig[] {
  return normalizeExternalAgentConfigList(agents).map((agent) => ({
    ...agent,
    args: [...agent.args],
    env: Object.fromEntries(
      Object.entries(agent.env).map(([key, value]) => [
        key,
        isSensitiveEnvKey(key) ? REDACTED_ENV_VALUE : value,
      ]),
    ),
  }));
}

function externalAgentConfigsEqual(
  left: ExternalAgentConfig[],
  right: ExternalAgentConfig[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasAiSettingsChanges(
  draft: {
    provider: NonNullable<AiConfig["provider"]>;
    apiKey: string;
    serverUrl: string;
    externalAgents: ExternalAgentConfig[];
  },
  saved: Pick<AiConfig, "provider" | "apiKey" | "serverUrl" | "externalAgents">,
): boolean {
  const draftExternalAgents = normalizeExternalAgentConfigList(draft.externalAgents);
  const savedExternalAgents = normalizeExternalAgentConfigList(saved.externalAgents);
  return (
    draft.provider !== (saved.provider ?? DEFAULT_PROVIDER) ||
    draft.apiKey !== (saved.apiKey ?? "") ||
    draft.serverUrl !== (saved.serverUrl ?? DEFAULT_SERVER_URL) ||
    !externalAgentConfigsEqual(draftExternalAgents, savedExternalAgents)
  );
}

function prepareAiConfigForSave(config: AiConfig): Record<string, unknown> {
  const normalizedExternalAgents = normalizeExternalAgentConfigList(config.externalAgents);
  const settings = {
    ...config,
    externalAgents: redactedExternalAgentConfig(normalizedExternalAgents),
  } as Record<string, unknown>;

  for (const agent of normalizedExternalAgents) {
    for (const [key, value] of Object.entries(agent.env)) {
      if (isSensitiveEnvKey(key)) {
        settings[externalAgentEnvSecureKey(agent.id, key)] = value;
      }
    }
  }

  return settings;
}

export {
  AI_CHAT_SETTINGS_PLUGIN_ID,
  AI_CHAT_SECURE_KEYS,
  DEFAULT_EXTERNAL_AGENTS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_PROXY_TIMEOUT_MS,
  DEFAULT_ROUND_LIMIT,
  DEFAULT_SERVER_URL,
  REDACTED_ENV_VALUE,
  CODEX_ACP_AGENT_ID,
  CODEX_ACP_PACKAGE,
  aiChatSecureKeysForConfig,
  aiChatSecureKeysForRawSettings,
  aiChatSecureKeysForSave,
  createDefaultAiConfig,
  externalAgentEnvSecureKey,
  externalAgentConfigsEqual,
  hasAiSettingsChanges,
  hydrateAiConfigExternalSecrets,
  isSensitiveEnvKey,
  normalizeAiConfig,
  normalizeExternalAgentConfigList,
  prepareAiConfigForSave,
  redactedExternalAgentConfig,
};
