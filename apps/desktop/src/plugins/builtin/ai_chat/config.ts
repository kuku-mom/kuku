import type { AiConfig } from "./types";

const AI_CHAT_SETTINGS_PLUGIN_ID = "ai-chat";
const AI_CHAT_SECURE_KEYS = ["apiKey"] as const;
const LEGACY_MODEL_ALIASES = new Set(["gemini-3.1-flash-lite-preview"]);
const DEFAULT_MODEL = "gemini-3.1-flash-lite";
const DEFAULT_PROVIDER = "remote" as const;
const DEFAULT_SERVER_URL =
  import.meta.env.VITE_KUKU_API_URL?.trim() ||
  (import.meta.env.PROD ? "https://api.kuku.mom" : "http://localhost:8080");
// Internal guardrails: these are intentionally kept out of the settings UI.
const DEFAULT_ROUND_LIMIT = 12;
const DEFAULT_PROXY_TIMEOUT_MS = 15_000;

function createDefaultAiConfig(): AiConfig {
  return {
    provider: DEFAULT_PROVIDER,
    apiKey: null,
    model: DEFAULT_MODEL,
    serverUrl: DEFAULT_SERVER_URL,
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

export {
  AI_CHAT_SETTINGS_PLUGIN_ID,
  AI_CHAT_SECURE_KEYS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_PROXY_TIMEOUT_MS,
  DEFAULT_ROUND_LIMIT,
  DEFAULT_SERVER_URL,
  createDefaultAiConfig,
  normalizeAiConfig,
};
