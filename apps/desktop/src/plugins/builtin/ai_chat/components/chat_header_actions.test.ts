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
    const newMenuIndex = source.indexOf("<AgentSessionMenu");
    const closeIndex = source.indexOf('data-kuku-close-chat-session="true"');

    expect(controlsIndex).toBeGreaterThan(-1);
    expect(selectIndex).toBeGreaterThan(controlsIndex);
    expect(newMenuIndex).toBeGreaterThan(selectIndex);
    expect(closeIndex).toBeGreaterThan(newMenuIndex);
  });

  it("keeps the session selector visible when one restored session exists", () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "chat_header.tsx");
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain("visibleSessionSummaries().length > 0");
  });

  it("falls back to the active session when summary reactivity is stale", () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "chat_header.tsx");
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain("activeSessionSummary");
    expect(source).toContain("visibleSessionSummaries");
    expect(source).toContain("summaries.length > 0 || !active");
    expect(source).toContain("return [active]");
    expect(source).toContain("<For each={visibleSessionSummaries()}>");
  });

  it("does not append message counts to session option labels", () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "chat_header.tsx");
    const source = readFileSync(sourcePath, "utf8");
    const optionStart = source.indexOf("<option value={item.id}>");
    const optionBlock = source.slice(optionStart, source.indexOf("</option>", optionStart));

    expect(optionStart).toBeGreaterThan(-1);
    expect(optionBlock).toContain("{item.title}");
    expect(optionBlock).not.toContain("messageCount");
  });

  it("uses the status dot instead of rendering a visible status label", () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "chat_header.tsx");
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain('data-kuku-session-status-indicator="true"');
    expect(source).toContain("STATUS_DOT_CLASSES[statusMeta().tone]");
    expect(source).toContain("aria-label={statusMeta().label}");
    expect(source).not.toMatch(/>\s*{statusMeta\(\)\.label}\s*<\/span>/);
  });

  it("presents the create-session action as a new chat button, not a delete button", () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "agent_session_menu.tsx");
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
