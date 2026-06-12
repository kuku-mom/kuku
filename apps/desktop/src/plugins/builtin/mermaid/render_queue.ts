const MERMAID_RENDER_QUEUE_CONCURRENCY = 1;

interface MermaidRenderQueueJob<T> {
  isCurrent?: () => boolean;
  run(): Promise<T> | T;
}

interface MermaidRenderQueueItem<T> {
  generation: number;
  isCurrent: () => boolean;
  reject(error: unknown): void;
  resolve(value: T | null): void;
  run(): Promise<T> | T;
  sequence: number;
}

class MermaidRenderQueueClearedError extends Error {
  constructor() {
    super("Mermaid render queue was cleared.");
    this.name = "MermaidRenderQueueClearedError";
  }
}

let activeJobs = 0;
let drainScheduled = false;
let nextSequence = 0;
let queueGeneration = 0;
let queue: MermaidRenderQueueItem<unknown>[] = [];

function enqueueMermaidRenderJob<T>(job: MermaidRenderQueueJob<T>): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    queue.push({
      generation: queueGeneration,
      isCurrent: job.isCurrent ?? (() => true),
      reject,
      resolve: (value: unknown) => resolve(value as T | null),
      run: () => job.run(),
      sequence: nextSequence,
    });
    nextSequence += 1;
    scheduleMermaidRenderQueueDrain();
  });
}

function clearMermaidRenderQueue(): void {
  queueGeneration += 1;
  const pending = queue;
  queue = [];
  drainScheduled = false;
  for (const item of pending) {
    item.reject(new MermaidRenderQueueClearedError());
  }
}

function isMermaidRenderQueueClearedError(error: unknown): boolean {
  return error instanceof MermaidRenderQueueClearedError;
}

function getMermaidRenderQueueStateForTest(): {
  active: number;
  pending: number;
} {
  return {
    active: activeJobs,
    pending: queue.length,
  };
}

function scheduleMermaidRenderQueueDrain(): void {
  if (drainScheduled) return;
  drainScheduled = true;
  queueMicrotask(() => {
    drainScheduled = false;
    drainMermaidRenderQueue();
  });
}

function drainMermaidRenderQueue(): void {
  while (activeJobs < MERMAID_RENDER_QUEUE_CONCURRENCY && queue.length > 0) {
    activeJobs += 1;
    void runNextMermaidRenderQueueItem().finally(() => {
      activeJobs -= 1;
      scheduleMermaidRenderQueueDrain();
    });
  }
}

async function runNextMermaidRenderQueueItem(): Promise<void> {
  await waitForMermaidRenderIdle();
  const item = queue.shift();
  if (!item) return;
  await runMermaidRenderQueueItem(item);
}

async function runMermaidRenderQueueItem<T>(item: MermaidRenderQueueItem<T>): Promise<void> {
  try {
    if (item.generation !== queueGeneration || !item.isCurrent()) {
      item.resolve(null);
      return;
    }

    const result = await item.run();
    if (item.generation !== queueGeneration || !item.isCurrent()) {
      item.resolve(null);
      return;
    }
    item.resolve(result);
  } catch (error: unknown) {
    if (item.generation !== queueGeneration) {
      item.reject(new MermaidRenderQueueClearedError());
      return;
    }
    item.reject(error);
  }
}

function waitForMermaidRenderIdle(): Promise<void> {
  return new Promise((resolve) => {
    const win = typeof window === "undefined" ? null : window;
    const requestIdle = win?.requestIdleCallback;
    if (requestIdle) {
      requestIdle.call(win, () => resolve(), { timeout: 500 });
      return;
    }

    if (win?.requestAnimationFrame) {
      win.requestAnimationFrame(() => resolve());
      return;
    }

    globalThis.setTimeout(() => resolve(), 1);
  });
}

export {
  clearMermaidRenderQueue,
  enqueueMermaidRenderJob,
  getMermaidRenderQueueStateForTest,
  isMermaidRenderQueueClearedError,
};
