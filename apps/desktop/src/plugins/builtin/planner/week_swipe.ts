export interface WeekSwipeSample {
  deltaX: number;
  deltaY: number;
  deltaMode?: number;
  timeStamp?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

type Timer = ReturnType<typeof setTimeout>;
export interface WeekSwipeOptions {
  onPreview: (offset: number) => void;
  onCommit: (direction: -1 | 1) => void;
  /** Called before preview returns to zero, so the host can enable its settling transition. */
  onRelease?: () => void;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}
export interface WeekSwipeRecognizer {
  /** True means the host should preventDefault on this horizontal wheel sample. */
  handle: (sample: WeekSwipeSample) => boolean;
  /** Ignore the current burst without resetting its navigation latch. */
  suspend: (observedInput?: boolean) => void;
  cancel: () => void;
  dispose: () => void;
}

const IDLE_MS = 180;
const AXIS_DISTANCE = 8;
const AXIS_DOMINANCE = 1.35;
const COMMIT_DISTANCE = 120;
const PREVIEW_LIMIT = 96;
const PREVIEW_FOLLOW = 0.7;

/** macOS wheel events do not expose a reliable gesture/momentum phase in WebView.
 * A quiet interval therefore marks the boundary; all horizontal inertia inside
 * that interval stays latched to one navigation, even after its preview settles.
 */
export function createWeekSwipeRecognizer(options: WeekSwipeOptions): WeekSwipeRecognizer {
  const now = options.now ?? (() => performance.now());
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  let timer: Timer | undefined;
  let lastTime: number | undefined;
  let axis: "horizontal" | "vertical" | undefined;
  let intentX = 0;
  let intentY = 0;
  let distance = 0;
  let committed = false;
  let ignored = false;
  let previewing = false;
  let disposed = false;

  const release = () => {
    if (!previewing) return;
    previewing = false;
    options.onRelease?.();
    options.onPreview(0);
  };
  const cancel = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    lastTime = undefined;
    release();
    axis = undefined;
    intentX = 0;
    intentY = 0;
    distance = 0;
    committed = false;
    ignored = false;
  };
  const keepAlive = () => {
    const time = now();
    // Timers may be delayed by rendering; use arrival time as the second guard.
    // Event.timeStamp can use a different clock after WebView resumes.
    if (lastTime !== undefined && time - lastTime >= IDLE_MS) cancel();
    lastTime = time;
    if (timer !== undefined) clearTimer(timer);
    timer = setTimer(() => {
      timer = undefined;
      cancel();
    }, IDLE_MS);
  };

  const suspend = (observedInput = false) => {
    if (disposed) return;
    if (observedInput) keepAlive();
    else if (lastTime === undefined) return;
    ignored = true;
    release();
  };

  return {
    handle(sample) {
      if (disposed) return false;
      // Ctrl+wheel is commonly a trackpad pinch. Modifier-assisted scrolling and
      // discrete LINE/PAGE wheels keep their platform behavior; converting their
      // units to pixels would turn a single wheel notch into a synthetic swipe.
      if (
        (sample.deltaMode ?? 0) !== 0 ||
        sample.ctrlKey ||
        sample.metaKey ||
        sample.altKey ||
        sample.shiftKey ||
        !Number.isFinite(sample.deltaX) ||
        !Number.isFinite(sample.deltaY)
      ) {
        if (
          lastTime !== undefined ||
          (Number.isFinite(sample.deltaX) &&
            Number.isFinite(sample.deltaY) &&
            (sample.deltaX !== 0 || sample.deltaY !== 0))
        ) {
          // A pinch or discrete wheel inside an existing burst is not a new
          // swipe. Preserve its commit latch and leave the rest of the burst
          // native until idle, instead of restarting navigation mid-inertia.
          suspend(true);
        }
        return false;
      }
      const x = Math.abs(sample.deltaX);
      const y = Math.abs(sample.deltaY);
      if (!x && !y) return false;
      keepAlive();
      if (ignored || axis === "vertical") return false;
      if (axis === undefined) {
        intentX += x;
        intentY += y;
        if (intentY >= AXIS_DISTANCE && intentY >= intentX * AXIS_DOMINANCE) {
          axis = "vertical";
          return false;
        }
        if (intentX < AXIS_DISTANCE || intentX < intentY * AXIS_DOMINANCE) return false;
        axis = "horizontal";
      }
      // Never suppress a vertical-dominant sample, including after a horizontal
      // gesture. It still extends the idle window without triggering a new week.
      if (!x || y > x * AXIS_DOMINANCE) return false;
      if (committed) return true;
      // Only distance claimed by the horizontal recognizer can move the week.
      // Earlier ambiguous samples already went to native scrolling.
      distance += sample.deltaX;
      previewing = true;
      options.onPreview(
        -Math.max(-PREVIEW_LIMIT, Math.min(PREVIEW_LIMIT, distance * PREVIEW_FOLLOW)),
      );
      if (Math.abs(distance) >= COMMIT_DISTANCE) {
        committed = true;
        try {
          options.onCommit(distance > 0 ? 1 : -1);
        } finally {
          release();
        }
      }
      return true;
    },
    suspend,
    cancel,
    dispose() {
      cancel();
      disposed = true;
    },
  };
}
