// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CODE_BLOCK_PREVIEW_INTERSECTION_ROOT_MARGIN,
  findCodeBlockPreviewObserverRoot,
  scheduleDeferredCodeBlockPreview,
} from "../code_block_preview_scheduler";

interface MockObserverRecord {
  callback: IntersectionObserverCallback;
  disconnected: boolean;
  observed: Element[];
  options?: IntersectionObserverInit;
}

let observers: MockObserverRecord[] = [];

class MockIntersectionObserver {
  private readonly record: MockObserverRecord;

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.record = {
      callback,
      disconnected: false,
      observed: [],
      options,
    };
    observers.push(this.record);
  }

  disconnect(): void {
    this.record.disconnected = true;
  }

  observe(target: Element): void {
    this.record.observed.push(target);
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  unobserve(target: Element): void {
    this.record.observed = this.record.observed.filter((entry) => entry !== target);
  }
}

function triggerIntersection(record: MockObserverRecord, isIntersecting: boolean): void {
  record.callback(
    [
      {
        isIntersecting,
        intersectionRatio: isIntersecting ? 1 : 0,
      } as IntersectionObserverEntry,
    ],
    {} as IntersectionObserver,
  );
}

describe("code block preview scheduler", () => {
  beforeEach(() => {
    observers = [];
    document.body.innerHTML = "";
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: MockIntersectionObserver,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "IntersectionObserver");
    vi.restoreAllMocks();
  });

  it("uses the editor scroll viewport as observer root", () => {
    const scrollRoot = document.createElement("div");
    const viewport = document.createElement("div");
    const editorRoot = document.createElement("div");
    scrollRoot.dataset.editorScroll = "";
    viewport.dataset.scrollAreaViewport = "";
    viewport.append(editorRoot);
    scrollRoot.append(viewport);
    document.body.append(scrollRoot);

    expect(findCodeBlockPreviewObserverRoot(editorRoot)).toBe(viewport);
  });

  it("observes deferred previews until they enter the near viewport", () => {
    const editorRoot = document.createElement("div");
    const target = document.createElement("div");
    const render = vi.fn();

    scheduleDeferredCodeBlockPreview({
      editorRoot,
      target,
      isCurrent: () => true,
      render,
    });

    expect(observers).toHaveLength(1);
    expect(observers[0]?.observed).toEqual([target]);
    expect(observers[0]?.options?.root).toBeNull();
    expect(observers[0]?.options?.rootMargin).toBe(CODE_BLOCK_PREVIEW_INTERSECTION_ROOT_MARGIN);

    triggerIntersection(observers[0]!, false);
    expect(render).not.toHaveBeenCalled();

    triggerIntersection(observers[0]!, true);
    expect(render).toHaveBeenCalledTimes(1);
    expect(observers[0]?.disconnected).toBe(true);
  });

  it("cancels stale observed previews without rendering", () => {
    const editorRoot = document.createElement("div");
    const target = document.createElement("div");
    const render = vi.fn();

    scheduleDeferredCodeBlockPreview({
      editorRoot,
      target,
      isCurrent: () => false,
      render,
    });
    triggerIntersection(observers[0]!, true);

    expect(render).not.toHaveBeenCalled();
    expect(observers[0]?.disconnected).toBe(true);
  });

  it("cancels observer lifecycle through its disposer", () => {
    const editorRoot = document.createElement("div");
    const target = document.createElement("div");
    const render = vi.fn();

    const dispose = scheduleDeferredCodeBlockPreview({
      editorRoot,
      target,
      isCurrent: () => true,
      render,
    });
    dispose();
    triggerIntersection(observers[0]!, true);

    expect(render).not.toHaveBeenCalled();
    expect(observers[0]?.disconnected).toBe(true);
  });

  it("falls back to eager frame scheduling when IntersectionObserver is unavailable", async () => {
    Reflect.deleteProperty(window, "IntersectionObserver");
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const editorRoot = document.createElement("div");
    const target = document.createElement("div");
    const render = vi.fn();

    scheduleDeferredCodeBlockPreview({
      editorRoot,
      target,
      isCurrent: () => true,
      render,
    });

    expect(render).toHaveBeenCalledTimes(1);
  });
});
