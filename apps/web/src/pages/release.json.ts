import { prodReleaseManifest } from "@/config/prod_release";

export const prerender = true;

export function GET(): Response {
  return new Response(`${JSON.stringify(prodReleaseManifest, null, 2)}\n`, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
