interface MenuKeyboardOptions {
  root?: HTMLElement;
  menu?: HTMLElement;
  close: () => void;
}

function enabledMenuItems(menu?: HTMLElement): HTMLElement[] {
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).filter((item) => {
    if (item.getAttribute("aria-disabled") === "true") return false;
    if ("disabled" in item && (item as HTMLButtonElement).disabled) return false;
    return true;
  });
}

function focusMenuItem(menu: HTMLElement | undefined, position: "first" | "last"): void {
  const items = enabledMenuItems(menu);
  const item = position === "last" ? items.at(-1) : items[0];
  item?.focus();
}

function handleMenuKeyboard(event: KeyboardEvent, options: MenuKeyboardOptions): void {
  if (event.key === "Escape") {
    event.preventDefault();
    options.close();
    options.root?.querySelector<HTMLElement>("[data-kuku-menu-trigger]")?.focus();
    return;
  }

  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;

  const items = enabledMenuItems(options.menu);
  if (items.length === 0) return;

  event.preventDefault();
  if (event.key === "Home") {
    items[0]?.focus();
    return;
  }
  if (event.key === "End") {
    items.at(-1)?.focus();
    return;
  }

  const currentIndex = items.findIndex((item) => item === document.activeElement);
  if (currentIndex === -1) {
    (event.key === "ArrowUp" ? items.at(-1) : items[0])?.focus();
    return;
  }

  const delta = event.key === "ArrowUp" ? -1 : 1;
  const nextIndex = (currentIndex + delta + items.length) % items.length;
  items[nextIndex]?.focus();
}

export { focusMenuItem, handleMenuKeyboard };
