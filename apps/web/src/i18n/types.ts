export const LOCALES = ["en", "ko", "ja"] as const;

export type Locale = (typeof LOCALES)[number];
