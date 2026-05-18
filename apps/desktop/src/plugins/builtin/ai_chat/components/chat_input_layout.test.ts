import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("chat input layout", () => {
  it("constrains the permission menu within the chat composer", () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "chat_input.tsx");
    const source = readFileSync(sourcePath, "utf8");
    const menuIndex = source.indexOf('data-kuku-permission-menu="true"');
    const menuBlock = source.slice(Math.max(0, menuIndex - 300), menuIndex + 300);

    expect(menuIndex).toBeGreaterThan(-1);
    expect(menuBlock).toContain("left-2");
    expect(menuBlock).toContain("right-2");
    expect(menuBlock).not.toContain("min-w-[17rem]");
  });

  it("marks the permission preset selector as disabled until it is wired to execution", () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "chat_input.tsx");
    const source = readFileSync(sourcePath, "utf8");
    const triggerIndex = source.indexOf('data-kuku-permission-preset-trigger="true"');
    const triggerBlock = source.slice(triggerIndex, triggerIndex + 500);

    expect(triggerIndex).toBeGreaterThan(-1);
    expect(triggerBlock).toContain("disabled");
    expect(triggerBlock).toContain("cursor-not-allowed");
    expect(triggerBlock).not.toContain("setShowPermissionMenu");
  });
});
