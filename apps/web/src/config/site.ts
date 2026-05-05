import { prodRelease } from "./prod_release";

export const siteUrl = {
  development: "http://localhost:4321",
  production: prodRelease.siteUrl,
} as const;

export function getSiteUrl(): string {
  return process.env.NODE_ENV === "production" ? siteUrl.production : siteUrl.development;
}
