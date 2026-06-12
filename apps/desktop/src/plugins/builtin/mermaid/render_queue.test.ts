// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearMermaidRenderQueue,
  enqueueMermaidRenderJob,
  getMermaidRenderQueueStateForTest,
  isMermaidRenderQueueClearedError,
} from "./render_queue";

type IdleCallback = NonNullable<typeof window.requestIdleCallback>;

let idleCallbacks: Parameters<IdleCallback>[0][] = [];

async function flushQueueMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

async function flushIdle(): Promise<void> {
  const callback = idleCallbacks.shift();
  callback?.({
    didTimeout: false,
    timeRemaining: () => 50,
  });
  await Promise.resolve();
}

function releaseRenderJob(release: (() => void) | null): void {
  if (!release) {
    throw new Error("Expected Mermaid render job to be active.");
  }
  release();
}

describe("mermaid render queue", () => {
  beforeEach(() => {
    clearMermaidRenderQueue();
    idleCallbacks = [];
    Object.defineProperty(window, "requestIdleCallback", {
      configurable: true,
      value: ((callback: Parameters<IdleCallback>[0]) => {
        idleCallbacks.push(callback);
        return idleCallbacks.length;
      }) satisfies IdleCallback,
    });
  });

  afterEach(() => {
    clearMermaidRenderQueue();
    Reflect.deleteProperty(window, "requestIdleCallback");
  });

  it("runs queued jobs in insertion order", async () => {
    const order: number[] = [];
    const first = enqueueMermaidRenderJob({ run: () => order.push(1) });
    const second = enqueueMermaidRenderJob({ run: () => order.push(2) });

    await flushQueueMicrotasks();
    await flushIdle();
    await first;
    await flushQueueMicrotasks();
    await flushIdle();
    await second;

    expect(order).toEqual([1, 2]);
  });

  it("keeps insertion order when new jobs arrive before idle time", async () => {
    const order: number[] = [];
    const first = enqueueMermaidRenderJob({ run: () => order.push(1) });

    await flushQueueMicrotasks();
    const second = enqueueMermaidRenderJob({ run: () => order.push(2) });
    await flushQueueMicrotasks();
    await flushIdle();
    await first;
    await flushQueueMicrotasks();
    await flushIdle();
    await second;

    expect(order).toEqual([1, 2]);
  });

  it("limits Mermaid renders to one active job", async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | null = null;
    let releaseSecond: (() => void) | null = null;
    const first = enqueueMermaidRenderJob({
      run: () =>
        new Promise<string>((resolve) => {
          order.push("first:start");
          releaseFirst = () => resolve("first");
        }),
    });
    const second = enqueueMermaidRenderJob({
      run: () =>
        new Promise<string>((resolve) => {
          order.push("second:start");
          releaseSecond = () => resolve("second");
        }),
    });

    await flushQueueMicrotasks();
    await flushIdle();

    expect(order).toEqual(["first:start"]);
    expect(getMermaidRenderQueueStateForTest()).toEqual({ active: 1, pending: 1 });

    releaseRenderJob(releaseFirst);
    await first;
    await flushQueueMicrotasks();
    await flushIdle();

    expect(order).toEqual(["first:start", "second:start"]);
    releaseRenderJob(releaseSecond);
    await second;
  });

  it("discards stale jobs before running them", async () => {
    const job = enqueueMermaidRenderJob({
      isCurrent: () => false,
      run: () => "rendered",
    });

    await flushQueueMicrotasks();
    await flushIdle();

    expect(await job).toBeNull();
  });

  it("returns null for active jobs cleared during plugin deactivate", async () => {
    let release: (() => void) | null = null;
    const job = enqueueMermaidRenderJob({
      run: () =>
        new Promise<string>((resolve) => {
          release = () => resolve("rendered");
        }),
    });

    await flushQueueMicrotasks();
    await flushIdle();
    clearMermaidRenderQueue();
    releaseRenderJob(release);

    expect(await job).toBeNull();
  });

  it("rejects pending jobs cleared during plugin deactivate", async () => {
    let releaseFirst: (() => void) | null = null;
    const first = enqueueMermaidRenderJob({
      run: () =>
        new Promise<string>((resolve) => {
          releaseFirst = () => resolve("first");
        }),
    });
    const pending = enqueueMermaidRenderJob({ run: () => "pending" });

    await flushQueueMicrotasks();
    await flushIdle();
    clearMermaidRenderQueue();
    releaseRenderJob(releaseFirst);

    await pending.catch((error: unknown) => {
      expect(isMermaidRenderQueueClearedError(error)).toBe(true);
    });
    expect(await first).toBeNull();
  });
});
