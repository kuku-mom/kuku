import { type MessageCatalog, type MessageKey } from "./keys";
import { EN_MESSAGES } from "./locales/en";
import { JA_MESSAGES } from "./locales/ja";
import { KO_MESSAGES } from "./locales/ko";
import { LOCALES, type Locale } from "./types";

export const MESSAGES = {
  en: EN_MESSAGES,
  ko: KO_MESSAGES,
  ja: JA_MESSAGES,
} satisfies Record<Locale, MessageCatalog>;

export const LANG_LABELS = {
  en: "English",
  ko: "한국어",
  ja: "日本語",
} satisfies Record<Locale, string>;

export function isLocale(value: string | null | undefined): value is Locale {
  return LOCALES.includes(value as Locale);
}

export function normalizeLocale(value: string | null | undefined): Locale {
  return isLocale(value) ? value : "en";
}

export function t(key: MessageKey, locale: Locale = "en"): string {
  return MESSAGES[locale][key] ?? EN_MESSAGES[key];
}

export function tf(
  key: MessageKey,
  vars: Record<string, string | number>,
  locale: Locale = "en",
): string {
  let text = t(key, locale);
  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{{${name}}}`, String(value));
  }
  return text;
}

export { MESSAGE_KEYS, type MessageCatalog, type MessageKey } from "./keys";
export { LOCALES, type Locale } from "./types";
