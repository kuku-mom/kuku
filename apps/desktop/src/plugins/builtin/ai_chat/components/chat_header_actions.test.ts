import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("chat header actions", () => {
  it("groups session switching, new-session, and close-session controls together", () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "chat_header.tsx");
    const source = readFileSync(sourcePath, "utf8");
    const controlsIndex = source.indexOf('data-kuku-session-controls="true"');
    const sessionMenuIndex = source.indexOf("<ChatSessionMenu");
    const newMenuIndex = source.indexOf("<AgentSessionMenu");
    const closeIndex = source.indexOf('data-kuku-close-chat-session="true"');

    expect(controlsIndex).toBeGreaterThan(-1);
    expect(sessionMenuIndex).toBeGreaterThan(controlsIndex);
    expect(newMenuIndex).toBeGreaterThan(sessionMenuIndex);
    expect(closeIndex).toBeGreaterThan(newMenuIndex);
  });

  it("presents session switching as a menu, not a native select", () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "chat_header.tsx");
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain("<ChatSessionMenu");
    expect(source).toContain("items={visibleSessionSummaries()}");
    expect(source).toContain("activeSessionId={chatState.activeSessionId}");
    expect(source).not.toContain("<select");
    expect(source).not.toContain('data-kuku-session-select="true"');
  });

  it("keeps the session switcher visible when one restored session exists", () => {
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
    expect(source).toContain("items={visibleSessionSummaries()}");
  });

  it("does not append message counts to session menu labels", () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "chat_session_menu.tsx");
    const source = readFileSync(sourcePath, "utf8");
    const labelStart = source.indexOf("{props.item.title}");
    const itemBlock = source.slice(Math.max(0, labelStart - 500), labelStart + 500);

    expect(labelStart).toBeGreaterThan(-1);
    expect(itemBlock).toContain("{props.item.title}");
    expect(itemBlock).not.toContain("messageCount");
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
