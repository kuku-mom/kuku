import { describe, expect, it } from "vitest";

import { BUILTIN_AGENT_CATALOG, KUKU_NATIVE_AGENT_ID } from "./agent_catalog";

describe("ai_chat agent catalog", () => {
  it("exposes Kuku native first and managed external agents as unavailable until backend catalog loads", () => {
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
        id: "claude-acp",
        label: "Claude Agent",
        kind: "acp",
        enabled: false,
        managed: true,
      },
      {
        id: "codex-acp",
        label: "Codex CLI",
        kind: "acp",
        enabled: false,
        managed: true,
      },
      {
        id: "gemini-acp",
        label: "Gemini CLI",
        kind: "acp",
        enabled: false,
        managed: true,
      },
    ]);
  });
});
