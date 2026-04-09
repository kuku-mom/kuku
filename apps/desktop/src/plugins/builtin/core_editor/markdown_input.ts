// ── Markdown Input Helpers ──
//
// Shared parsing helpers for raw markdown-style editor input rules.
// These are intentionally tiny and local to core_editor so that link/image
// rules can share the same bracket balancing behavior.

export interface ParsedMarkdownLinkLike {
  label: string;
  target: string;
}

/**
 * Parse `![label](target)` or `[label](target)` from a raw text fragment.
 *
 * Supports nested square brackets in the label, which the CommonMark spec
 * allows. The target parsing stays conservative: it requires a simple
 * non-whitespace, non-`)` target because these rules are for live typing.
 */
export function parseMarkdownLinkLikeSyntax(
  source: string,
  options: { image: boolean; allowEmptyLabel?: boolean },
): ParsedMarkdownLinkLike | null {
  const prefix = options.image ? "![" : "[";
  if (!source.startsWith(prefix)) return null;
  if (!source.endsWith(")")) return null;

  const labelStart = prefix.length;
  let depth = 0;

  for (let i = labelStart; i < source.length - 1; i++) {
    const char = source[i];

    if (char === "\\") {
      i += 1;
      continue;
    }

    if (char === "[") {
      depth += 1;
      continue;
    }

    if (char === "]") {
      if (depth > 0) {
        depth -= 1;
        continue;
      }

      if (source[i + 1] !== "(") return null;

      const label = source.slice(labelStart, i);
      const target = source.slice(i + 2, -1);
      if ((!label.length && !options.allowEmptyLabel) || !target.length) return null;
      if (/\s|\)/.test(target)) return null;

      return { label, target };
    }
  }

  return null;
}
