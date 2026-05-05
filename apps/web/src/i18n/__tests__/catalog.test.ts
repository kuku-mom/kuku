import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MESSAGE_KEYS, type MessageCatalog } from "@/i18n/keys";
import { EN_MESSAGES } from "@/i18n/locales/en";
import { JA_MESSAGES } from "@/i18n/locales/ja";
import { KO_MESSAGES } from "@/i18n/locales/ko";
import { LOCALES, type Locale } from "@/i18n/types";

const CATALOGS = {
  en: EN_MESSAGES,
  ko: KO_MESSAGES,
  ja: JA_MESSAGES,
} satisfies Record<Locale, MessageCatalog>;

const STATIC_I18N_ATTRS = ["data-i18n", "data-i18n-html", "data-i18n-placeholder"] as const;
const SOURCE_EXTENSIONS = new Set([".astro", ".ts", ".tsx"]);
const srcRoot = fileURLToPath(new URL("../../", import.meta.url));
const I18N_NAMESPACES = new Set(MESSAGE_KEYS.map((key) => key.split(".")[0]));

function sorted(values: Iterable<string>): string[] {
  return [...values].toSorted((left, right) => left.localeCompare(right));
}

function placeholders(message: string): string[] {
  const names = new Set<string>();
  for (const match of message.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
    const name = match[1];
    if (name) names.add(name);
  }
  return sorted(names);
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...sourceFiles(fullPath));
      continue;
    }

    if (SOURCE_EXTENSIONS.has(extname(entry))) {
      files.push(fullPath);
    }
  }

  return files;
}

function staticI18nKeys(source: string): string[] {
  const keys: string[] = [];

  for (const attr of STATIC_I18N_ATTRS) {
    const pattern = new RegExp(`${attr}=(["'])([^"'{]+)\\1`, "g");
    for (const match of source.matchAll(pattern)) {
      const key = match[2];
      if (key) keys.push(key);
    }
  }

  return keys;
}

function i18nKeyLiterals(source: string): string[] {
  const keys: string[] = [];

  for (const match of source.matchAll(/["']([A-Za-z][A-Za-z0-9]*(?:[._][A-Za-z0-9]+)+)["']/g)) {
    const key = match[1];
    const namespace = key?.split(".")[0];
    if (key && namespace && I18N_NAMESPACES.has(namespace)) {
      keys.push(key);
    }
  }

  return keys;
}

describe("web i18n message catalogs", () => {
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

  it("keeps static data-i18n attributes backed by the canonical key list", () => {
    const keySet = new Set<string>(MESSAGE_KEYS);
    const missing: string[] = [];

    for (const file of sourceFiles(srcRoot)) {
      const source = readFileSync(file, "utf8");
      for (const key of staticI18nKeys(source)) {
        if (!keySet.has(key)) {
          missing.push(`${relative(srcRoot, file)}: ${key}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it("keeps i18n-looking string literals backed by the canonical key list", () => {
    const keySet = new Set<string>(MESSAGE_KEYS);
    const missing: string[] = [];

    for (const file of sourceFiles(srcRoot)) {
      const source = readFileSync(file, "utf8");
      for (const key of i18nKeyLiterals(source)) {
        if (!keySet.has(key)) {
          missing.push(`${relative(srcRoot, file)}: ${key}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
