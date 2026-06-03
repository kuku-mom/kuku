import { describe, expect, it } from "vitest";

import {
  chatSessionStorageKey,
  filterForChatSessionVaultRoot,
  normalizeChatSessionVaultRoot,
} from "./chat_session_scope";

describe("chat session vault scope", () => {
  it("normalizes vault roots for stable session scoping", () => {
    expect(normalizeChatSessionVaultRoot(" /Users/me/Vault/ ")).toBe("/Users/me/Vault");
    expect(normalizeChatSessionVaultRoot("\\Users\\me\\Vault\\")).toBe("/Users/me/Vault");
    expect(normalizeChatSessionVaultRoot("")).toBeNull();
    expect(normalizeChatSessionVaultRoot(null)).toBeNull();
  });

  it("creates scoped storage keys without using the legacy global key", () => {
    expect(chatSessionStorageKey("/Users/me/Vault")).toBe(
      "kuku.aiChat.sessions.v1:%2FUsers%2Fme%2FVault",
    );
    expect(chatSessionStorageKey(null)).toBe("kuku.aiChat.sessions.v1:no-vault");
  });

  it("filters sessions by exact normalized vault root without falling back to unrelated roots", () => {
    const sessions = [
      { id: "vault-a", workingDirectory: "/Users/me/Vault A/" },
      { id: "vault-b", workingDirectory: "/Users/me/Vault B" },
      { id: "legacy-global" },
    ];

    expect(filterForChatSessionVaultRoot(sessions, "/Users/me/Vault A")).toEqual([
      { id: "vault-a", workingDirectory: "/Users/me/Vault A/" },
    ]);
    expect(filterForChatSessionVaultRoot(sessions, "/Users/me/Missing")).toEqual([]);
  });
});
