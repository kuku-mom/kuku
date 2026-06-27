function platformText(): string {
  if (typeof navigator === "undefined") return "";
  return `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
}

function isMacPlatform(): boolean {
  return platformText().includes("mac");
}

function formatModifierSymbols(value: string): string {
  const labels: string[] = [];
  for (const symbol of value) {
    const label =
      symbol === "\u2318" || symbol === "\u2303"
        ? "Ctrl"
        : symbol === "\u2325"
          ? "Alt"
          : symbol === "\u21e7"
            ? "Shift"
            : symbol;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.join("+");
}

function formatShortcutSymbols(value: string): string {
  if (isMacPlatform()) return value;

  if (/^[\u2318\u2303\u2325\u21e7]+$/.test(value)) {
    return formatModifierSymbols(value);
  }

  return value.replace(
    /[\u2318\u2303\u2325\u21e7]+(?=.)/g,
    (match) => `${formatModifierSymbols(match)}+`,
  );
}

export { formatShortcutSymbols, isMacPlatform };
