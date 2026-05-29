import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("chat header actions", () => {
  it("groups session switching, new-session, and close-session controls together", () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "chat_header.tsx");
    const source = readFileSync(sourcePath, "utf8");
    const controlsIndex = source.indexOf('data-kuku-session-controls="true"');
    const selectIndex = source.indexOf('data-kuku-session-select="true"');
    const newIndex = source.indexOf('data-kuku-new-chat-session="true"');
    const closeIndex = source.indexOf('data-kuku-close-chat-session="true"');

    expect(controlsIndex).toBeGreaterThan(-1);
    expect(selectIndex).toBeGreaterThan(controlsIndex);
    expect(newIndex).toBeGreaterThan(selectIndex);
    expect(closeIndex).toBeGreaterThan(newIndex);
  });

  it("keeps the session selector visible when one restored session exists", () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "chat_header.tsx");
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain("sessionSummaries().length > 0");
  });

  it("presents the create-session action as a new chat button, not a delete button", () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "chat_header.tsx");
    const source = readFileSync(sourcePath, "utf8");
    const actionStart = source.indexOf('data-kuku-new-chat-session="true"');
    const actionBlock = source.slice(actionStart, actionStart + 1200);

    expect(actionStart).toBeGreaterThan(-1);
    expect(actionBlock).toContain('title={t("chat.header.new_session")}');
    expect(actionBlock).toContain('aria-label={t("chat.header.new_session")}');
    expect(actionBlock).toContain('<path d="M12 5v14"');
    expect(actionBlock).toContain('<path d="M5 12h14"');
    expect(actionBlock).not.toContain('<span>{t("chat.header.new_session")}</span>');
    expect(actionBlock).not.toContain('<path d="M3 6h18"');
    expect(actionBlock).not.toContain("V6");
  });

  it("presents the close-session action separately from new-session", () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "chat_header.tsx");
    const source = readFileSync(sourcePath, "utf8");
    const actionStart = source.indexOf('data-kuku-close-chat-session="true"');
    const actionBlock = source.slice(actionStart, actionStart + 1200);

    expect(actionStart).toBeGreaterThan(-1);
    expect(actionBlock).toContain('title={t("chat.header.close_session")}');
    expect(actionBlock).toContain('aria-label={t("chat.header.close_session")}');
    expect(actionBlock).toContain('<path d="M6 6l12 12"');
    expect(actionBlock).toContain('<path d="M18 6L6 18"');
    expect(actionBlock).not.toContain('<span>{t("chat.header.close_session")}</span>');
    expect(actionBlock).toContain("closeSession");
  });
});
