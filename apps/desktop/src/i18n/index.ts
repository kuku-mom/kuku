import { type UiLanguage, settingsState } from "~/stores/settings";

import { type MessageCatalog, type MessageKey } from "./keys";
import { EN_MESSAGES } from "./locales/en";
import { JA_MESSAGES } from "./locales/ja";
import { KO_MESSAGES } from "./locales/ko";
import { type Locale } from "./types";

const MESSAGES: Record<Locale, MessageCatalog> = {
  en: EN_MESSAGES,
  ko: KO_MESSAGES,
  ja: JA_MESSAGES,
};

function normalizeNavigatorLocale(value: string | undefined | null): Locale {
  if (!value) return "en";
  const lower = value.toLowerCase();
  if (lower.startsWith("ko")) return "ko";
  if (lower.startsWith("ja")) return "ja";
  return "en";
}

function resolveSystemLocale(): Locale {
  if (typeof navigator === "undefined") return "en";

  const preferred = navigator.languages?.[0] ?? navigator.language;
  return normalizeNavigatorLocale(preferred);
}

function resolveLocale(language: UiLanguage): Locale {
  if (language === "system") {
    return resolveSystemLocale();
  }

  if (language === "ko") return "ko";
  if (language === "ja") return "ja";
  return "en";
}

export function currentLocale(): Locale {
  return resolveLocale(settingsState.appearance.language);
}

export function t(key: MessageKey): string {
  const locale = currentLocale();
  return MESSAGES[locale][key] ?? EN_MESSAGES[key];
}

export function tf(key: MessageKey, vars: Record<string, string | number>): string {
  let text = t(key);
  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{{${name}}}`, String(value));
  }
  return text;
}

export { MESSAGE_KEYS, type MessageCatalog, type MessageKey } from "./keys";
export { LOCALES, type Locale } from "./types";
