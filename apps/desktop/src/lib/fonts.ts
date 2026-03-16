import { invoke } from "@tauri-apps/api/core";

// ── Built-in font map ──

/**
 * Maps stored setting identifiers to their actual @font-face font-family names.
 * System fonts use the family name directly and don't need an entry here.
 */
export const BUILTIN_FONT_MAP: Record<string, string> = {
  "goorm-sans": "Goorm Sans",
  "goorm-sans-code": "Goorm Sans Code",
};

/**
 * Resolves a stored font identifier to the CSS font-family value.
 * Built-in fonts map to their @font-face name; system fonts pass through as-is.
 */
export function getCssFontFamily(family: string): string {
  return BUILTIN_FONT_MAP[family] ?? family;
}

// ── Types ──

export type FontFilter = "all" | "monospace" | "proportional" | "user" | "system";

export interface FontInfo {
  family: string;
  monospace: boolean;
  user: boolean;
}

export interface FontPage {
  fonts: FontInfo[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ListFontsOptions {
  filter?: FontFilter;
  query?: string;
  page?: number;
  pageSize?: number;
}

// ── Commands ──

/**
 * Pre-warms the font cache on the Rust side.
 * Call once at app startup so the first `listSystemFonts` call returns instantly.
 */
export async function initFonts(): Promise<void> {
  await invoke("init_fonts");
}

/**
 * Returns a paginated, optionally filtered and searched list of system fonts.
 *
 * @param options.filter    - "all" | "monospace" | "proportional" (default: "all")
 * @param options.query     - case-insensitive substring search on family name
 * @param options.page      - zero-based page index (default: 0)
 * @param options.pageSize  - items per page, clamped to 1–200 (default: 50)
 */

export async function listSystemFonts(options: ListFontsOptions = {}): Promise<FontPage> {
  return invoke<FontPage>("list_system_fonts", {
    filter: options.filter ?? "all",
    query: options.query ?? "",
    page: options.page ?? 0,
    pageSize: options.pageSize ?? 50,
  });
}
