import { describe, expect, it } from "vitest";

import { BUILTIN_AGENT_CATALOG, KUKU_NATIVE_AGENT_ID } from "./agent_catalog";

describe("ai_chat agent catalog", () => {
  it("exposes Kuku native first and Codex as the only managed external agent", () => {
    expect(KUKU_NATIVE_AGENT_ID).toBe("kuku-native");
    expect(BUILTIN_AGENT_CATALOG).toEqual([
      {
        id: "kuku-native",
        label: "Kuku Agent",
        kind: "native",
        enabled: true,
        managed: true,
      },
      {
        id: "codex-acp",
        label: "Codex CLI",
        kind: "acp",
        enabled: false,
        managed: true,
      },
    ]);
  });
});
