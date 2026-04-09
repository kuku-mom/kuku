// ── Anchor Click Handler Registry ──
//
// Decoupled dispatch for `<a>` tag clicks inside the editor.
//
// Problem: core_editor owns the single `handleDOMEvents.click` plugin
// for all `<a>` tags, but different plugins render different kinds of
// anchors (external links, wikilinks, embeds, …). Without a registry,
// core_editor would need to know about every plugin's anchor format.
//
// Solution: plugins register a CSS selector + handler during activation.
// core_editor's click handler calls `dispatchAnchorClick(anchor)` first.
// If a registered handler matches → delegate. No match → default opener.
//
// Usage (plugin side):
//   activate(ctx) {
//     const dispose = registerAnchorHandler("a[data-wikilink]", (anchor) => {
//       const target = anchor.getAttribute("data-target");
//       // … open internal note …
//       return true;
//     });
//     ctx.track(dispose);
//   }
//
// Usage (core_editor side):
//   if (dispatchAnchorClick(anchor)) return true;
//   // else: default opener behaviour

type Disposer = () => void;

/**
 * Handler receives the matched `<a>` element.
 * Return `true` if the click was handled, `false` to pass through.
 */
export type AnchorClickHandler = (anchor: HTMLAnchorElement) => boolean;

interface HandlerEntry {
  selector: string;
  handler: AnchorClickHandler;
}

const handlers: HandlerEntry[] = [];

/**
 * Register a click handler for anchors matching `selector`.
 *
 * @param selector  CSS selector to match against the `<a>` element
 *                  (e.g. `"a[data-wikilink]"`, `"a[data-embed]"`)
 * @param handler   Called when a matching anchor is clicked
 * @returns         Disposer that removes the registration
 */
export function registerAnchorHandler(selector: string, handler: AnchorClickHandler): Disposer {
  const entry: HandlerEntry = { selector, handler };
  handlers.push(entry);

  return () => {
    const idx = handlers.indexOf(entry);
    if (idx !== -1) handlers.splice(idx, 1);
  };
}

/**
 * Try to dispatch an anchor click to a registered handler.
 *
 * Iterates registered handlers in registration order.
 * Returns `true` if a handler matched **and** handled the click.
 * Returns `false` if no handler matched — caller should apply
 * default behaviour (e.g. open in external browser).
 */
export function dispatchAnchorClick(anchor: HTMLAnchorElement): boolean {
  for (const entry of handlers) {
    if (anchor.matches(entry.selector)) {
      if (entry.handler(anchor)) return true;
    }
  }
  return false;
}
