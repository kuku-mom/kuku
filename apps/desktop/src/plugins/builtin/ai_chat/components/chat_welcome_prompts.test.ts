import { describe, expect, it } from "vitest";

import type { MessageKey } from "~/i18n";
import { KO_MESSAGES } from "~/i18n/locales/ko";
import { getSuggestedPrompts } from "./chat_welcome";

describe("chat welcome prompts", () => {
  it("uses Korean prompt text when the app language is Korean", () => {
    const translate = (key: MessageKey): string => KO_MESSAGES[key];

    expect(getSuggestedPrompts(translate)[0]).toMatchObject({
      intentId: "find_related_notes",
      mode: "agent",
      permissionProfile: "read-only",
      prompt: "이 문서와 관련된 노트를 찾아서 서로 어떻게 연결되는지 보여줘",
    });
  });

  it("keeps welcome prompts mapped to stable intent metadata", () => {
    const translate = (key: MessageKey): string => KO_MESSAGES[key];

    expect(
      getSuggestedPrompts(translate).map((item) => ({
        intentId: item.intentId,
        permissionProfile: item.permissionProfile,
      })),
    ).toEqual([
      { intentId: "find_related_notes", permissionProfile: "read-only" },
      { intentId: "summarize_current_document", permissionProfile: "read-only" },
      { intentId: "draft_wiki_from_source", permissionProfile: "agent-workflow" },
      { intentId: "suggest_vault_links", permissionProfile: "agent-workflow" },
    ]);
  });
});
