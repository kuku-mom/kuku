// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { handleMenuKeyboard } from "./menu_keyboard";

describe("menu popover keyboard handling", () => {
  it("moves focus through enabled menu items with arrow keys", () => {
    const root = document.createElement("div");
    const trigger = document.createElement("button");
    trigger.setAttribute("data-kuku-menu-trigger", "true");
    const menu = document.createElement("div");
    const first = document.createElement("button");
    first.setAttribute("role", "menuitem");
    const disabled = document.createElement("button");
    disabled.setAttribute("role", "menuitem");
    disabled.setAttribute("disabled", "");
    const second = document.createElement("button");
    second.setAttribute("role", "menuitem");
    root.append(trigger);
    menu.append(first, disabled, second);
    document.body.append(root, menu);

    handleMenuKeyboard(
      { key: "ArrowDown", preventDefault: vi.fn() } as unknown as KeyboardEvent,
      { root, menu, close: vi.fn() },
    );
    expect(document.activeElement).toBe(first);

    handleMenuKeyboard(
      { key: "ArrowUp", preventDefault: vi.fn() } as unknown as KeyboardEvent,
      { root, menu, close: vi.fn() },
    );
    expect(document.activeElement).toBe(second);
  });

  it("closes the menu and returns focus to the trigger on escape", () => {
    const root = document.createElement("div");
    const trigger = document.createElement("button");
    trigger.setAttribute("data-kuku-menu-trigger", "true");
    const menu = document.createElement("div");
    root.append(trigger);
    document.body.append(root, menu);
    const close = vi.fn();

    handleMenuKeyboard(
      { key: "Escape", preventDefault: vi.fn() } as unknown as KeyboardEvent,
      { root, menu, close },
    );

    expect(close).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(trigger);
  });
});
