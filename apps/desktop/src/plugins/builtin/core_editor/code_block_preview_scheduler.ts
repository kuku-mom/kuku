import type { Disposer } from "~/plugins/types";

const CODE_BLOCK_PREVIEW_INTERSECTION_ROOT_MARGIN = "1000px 0px";
const CODE_BLOCK_PREVIEW_INTERSECTION_MARGIN_PX = 1000;

interface DeferredCodeBlockPreviewOptions {
  editorRoot: HTMLElement;
  isCurrent(): boolean;
  render(): void;
  target: HTMLElement;
}

function scheduleDeferredCodeBlockPreview(options: DeferredCodeBlockPreviewOptions): Disposer {
  const win = options.target.ownerDocument.defaultView;
  if (!win) return scheduleDeferredPreviewFrameFallback(options);

  const IntersectionObserverCtor = win.IntersectionObserver;
  if (!IntersectionObserverCtor) {
    return scheduleDeferredPreviewFrameFallback(options);
  }

  let disposed = false;
  const observer = new IntersectionObserverCtor(
    (entries) => {
      if (disposed) return;
      if (!options.isCurrent()) {
        dispose();
        return;
      }
      if (!entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)) {
        return;
      }

      dispose();
      options.render();
    },
    {
      root: findCodeBlockPreviewObserverRoot(options.editorRoot),
      rootMargin: CODE_BLOCK_PREVIEW_INTERSECTION_ROOT_MARGIN,
    },
  );

  observer.observe(options.target);

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
  }

  return dispose;
}

function findCodeBlockPreviewObserverRoot(editorRoot: HTMLElement): HTMLElement | null {
  const closestViewport = editorRoot.closest<HTMLElement>("[data-scroll-area-viewport]");
  if (closestViewport) return closestViewport;

  return editorRoot.ownerDocument.querySelector<HTMLElement>(
    "[data-editor-scroll] [data-scroll-area-viewport]",
  );
}

function isCodeBlockPreviewNearViewport(
  target: HTMLElement,
  editorRoot: HTMLElement,
  margin = CODE_BLOCK_PREVIEW_INTERSECTION_MARGIN_PX,
): boolean {
  const win = target.ownerDocument.defaultView;
  if (!win) return true;

  const targetRect = target.getBoundingClientRect();
  const root = findCodeBlockPreviewObserverRoot(editorRoot);
  const rootRect = root?.getBoundingClientRect();
  const viewportTop = rootRect?.top ?? 0;
  const viewportBottom = rootRect?.bottom ?? win.innerHeight;

  return targetRect.bottom >= viewportTop - margin && targetRect.top <= viewportBottom + margin;
}

function scheduleDeferredPreviewFrameFallback(options: DeferredCodeBlockPreviewOptions): Disposer {
  const win = options.target.ownerDocument.defaultView;
  let disposed = false;
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  let frameId: number | null = null;

  const render = () => {
    if (disposed || !options.isCurrent()) return;
    options.render();
  };

  if (win?.requestAnimationFrame) {
    frameId = win.requestAnimationFrame(render);
  } else {
    timeoutId = globalThis.setTimeout(render, 16);
  }

  return () => {
    disposed = true;
    if (frameId !== null) {
      win?.cancelAnimationFrame(frameId);
    }
    if (timeoutId !== null) {
      globalThis.clearTimeout(timeoutId);
    }
  };
}

export {
  CODE_BLOCK_PREVIEW_INTERSECTION_ROOT_MARGIN,
  findCodeBlockPreviewObserverRoot,
  isCodeBlockPreviewNearViewport,
  scheduleDeferredCodeBlockPreview,
};
