import { describe, expect, it } from "vitest";

import { MESSAGE_KEYS, type MessageCatalog } from "../keys";
import { EN_MESSAGES } from "../locales/en";
import { JA_MESSAGES } from "../locales/ja";
import { KO_MESSAGES } from "../locales/ko";
import { LOCALES, type Locale } from "../types";

const CATALOGS = {
  en: EN_MESSAGES,
  ko: KO_MESSAGES,
  ja: JA_MESSAGES,
} satisfies Record<Locale, MessageCatalog>;

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function placeholders(message: string): string[] {
  const names = new Set<string>();
  for (const match of message.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
    const name = match[1];
    if (name) names.add(name);
  }
  return sorted(names);
}

describe("i18n message catalogs", () => {
  it("keeps the canonical message key list unique", () => {
    expect(new Set(MESSAGE_KEYS).size).toBe(MESSAGE_KEYS.length);
  });

  it("keeps every locale catalog aligned with the canonical key list", () => {
    const expectedKeys = sorted(MESSAGE_KEYS);

    for (const locale of LOCALES) {
      const actualKeys = sorted(Object.keys(CATALOGS[locale]));

      expect(actualKeys, `${locale} catalog keys`).toEqual(expectedKeys);
    }
  });

  it("does not allow empty translation values", () => {
    for (const locale of LOCALES) {
      const emptyKeys = MESSAGE_KEYS.filter((key) => CATALOGS[locale][key].trim() === "");

      expect(emptyKeys, `${locale} empty translations`).toEqual([]);
    }
  });

  it("keeps interpolation placeholders consistent with English", () => {
    for (const locale of LOCALES) {
      for (const key of MESSAGE_KEYS) {
        expect(placeholders(CATALOGS[locale][key]), `${locale}.${key} placeholders`).toEqual(
          placeholders(EN_MESSAGES[key]),
        );
      }
    }
  });
});
