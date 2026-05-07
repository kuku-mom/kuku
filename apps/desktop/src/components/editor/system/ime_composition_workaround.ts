import type { EditorView } from "prosekit/pm/view";

/**
 * WebKit/macOS IME workaround for ProseMirror contenteditable editors.
 *
 * On some macOS WebKit builds, Korean IME input can produce this invalid event
 * sequence inside ProseMirror:
 *
 *   beforeinput insertCompositionText "ㄱ" isComposing=true
 *   compositionstart
 *   compositionupdate "ㄱ"
 *   beforeinput insertCompositionText "ㄱ" isComposing=true
 *   compositionstart
 *   compositionupdate "ㄱ"
 *   beforeinput insertCompositionText "ㄱ" isComposing=true
 *   beforeinput insertText "ㄱ" isComposing=false
 *
 * The native `compositionend` is missing, and the interim composition updates
 * are inserted as real DOM changes. ProseMirror then parses those DOM changes,
 * so one committed jamo becomes multiple document insertions.
 *
 * This matches the long-standing Safari failure mode described in
 * ProseMirror #944: if the editor re-selects the DOM selection immediately
 * after `compositionstart`, WebKit may stop firing `compositionend` and keep
 * sending redundant composition starts/updates.
 *
 * The workaround has two layers:
 * 1. Suppress ProseMirror DOM selection writes while `view.composing` is true.
 * 2. If WebKit has already entered a broken sequence, cancel interim
 *    `insertCompositionText` updates and let only the final `insertText`
 *    commit through.
 */

type SetSelection = (this: unknown, ...args: unknown[]) => void;

interface DocViewLike {
  setSelection?: SetSelection;
}

// `docView` is an internal ProseMirror field. There is no public hook for
// preventing selection writes during IME composition, so the guard below keeps
// the type surface deliberately tiny and local to this workaround.
interface InternalEditorView {
  dom: HTMLElement;
  docView?: DocViewLike | null;
  composing?: boolean;
}

function isInputEvent(event: Event): event is InputEvent {
  return typeof InputEvent !== "undefined" && event instanceof InputEvent;
}

function isViewComposing(view: EditorView): boolean {
  return Boolean((view as InternalEditorView).composing);
}

function createCompositionEndEvent(data: string): CompositionEvent {
  const init: CompositionEventInit = { bubbles: true, cancelable: true, data };
  if (typeof CompositionEvent === "function") {
    return new CompositionEvent("compositionend", init);
  }

  // jsdom and some embedded webviews may not expose CompositionEvent as a
  // constructable global. ProseMirror only needs an event named
  // `compositionend`, plus the data payload for parity with native events.
  const event = new Event("compositionend", init) as CompositionEvent;
  Object.defineProperty(event, "data", { value: data });
  return event;
}

function dispatchSyntheticCompositionEnd(view: EditorView, data: string): void {
  view.dom.dispatchEvent(createCompositionEndEvent(data));
}

function installCompositionSelectionGuard(view: EditorView): () => void {
  const internalView = view as InternalEditorView;
  const originalDescriptor = Object.getOwnPropertyDescriptor(internalView, "docView");
  const patchedDocViews = new WeakMap<DocViewLike, SetSelection>();
  const patchedDocViewRefs: DocViewLike[] = [];
  let currentDocView = internalView.docView ?? null;

  const patchDocView = (docView: DocViewLike | null | undefined): DocViewLike | null => {
    if (!docView?.setSelection || patchedDocViews.has(docView)) {
      return docView ?? null;
    }

    const originalSetSelection = docView.setSelection;
    patchedDocViews.set(docView, originalSetSelection);
    patchedDocViewRefs.push(docView);
    docView.setSelection = function setSelection(...args: unknown[]) {
      // This is the critical #944 guard. While a native IME owns the
      // composition range, writing the DOM selection can break WebKit's IME
      // lifecycle and leave ProseMirror permanently composing.
      if (isViewComposing(view)) return;
      return originalSetSelection.apply(this, args);
    };

    return docView;
  };

  currentDocView = patchDocView(currentDocView);

  try {
    // ProseMirror can replace `view.docView` after a redraw. Wrapping the
    // property lets us patch replacement doc views without changing
    // ProseMirror source or vendoring prosemirror-view.
    Object.defineProperty(internalView, "docView", {
      configurable: true,
      enumerable: originalDescriptor?.enumerable ?? true,
      get() {
        return currentDocView;
      },
      set(nextDocView: DocViewLike | null) {
        currentDocView = patchDocView(nextDocView);
      },
    });
  } catch {
    // If ProseMirror ever makes this internal property non-configurable, the
    // initial docView patch still covers the common non-redraw input path.
  }

  return () => {
    // Restore every docView we patched. This matters during editor teardown and
    // also keeps tests honest when a fake view swaps docView instances.
    for (const docView of patchedDocViewRefs) {
      const originalSetSelection = patchedDocViews.get(docView);
      if (!originalSetSelection) continue;
      if (docView.setSelection !== originalSetSelection) {
        docView.setSelection = originalSetSelection;
      }
    }

    if (originalDescriptor) {
      const restoredDescriptor =
        "value" in originalDescriptor
          ? { ...originalDescriptor, value: currentDocView }
          : originalDescriptor;
      Object.defineProperty(internalView, "docView", restoredDescriptor);
    } else {
      delete internalView.docView;
      internalView.docView = currentDocView;
    }
  };
}

function installBrokenWebKitInputGuard(view: EditorView): () => void {
  const dom = view.dom;
  let nativeCompositionActive = false;
  let brokenCompositionSequence = false;

  const markBrokenSequence = () => {
    brokenCompositionSequence = true;
  };

  const handleCompositionStart = () => {
    // A second compositionstart without a compositionend is a strong signal
    // that WebKit has entered the bad state. Normal IME sessions should be
    // start -> update(s) -> end.
    if (nativeCompositionActive) {
      markBrokenSequence();
    }
    nativeCompositionActive = true;
  };

  const handleCompositionEnd = () => {
    nativeCompositionActive = false;
    brokenCompositionSequence = false;
  };

  const handleBeforeInput = (event: Event) => {
    if (!isInputEvent(event)) return;

    if (event.inputType === "insertCompositionText" && event.isComposing) {
      // Another bad-state signal from the observed macOS 26.4.1 sequence:
      // WebKit sometimes sends an insertCompositionText before compositionstart.
      if (!nativeCompositionActive) {
        markBrokenSequence();
      }

      if (brokenCompositionSequence) {
        // Letting these interim updates through is what creates the repeated
        // characters. The final non-composing insertText event still commits
        // the user's actual input below.
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }

    if (event.inputType !== "insertText" || event.isComposing) return;

    // The final commit arrived. If WebKit never sent compositionend, synthesize
    // one so ProseMirror clears `view.composing` and keymaps such as Mod-s work.
    if (isViewComposing(view)) {
      dispatchSyntheticCompositionEnd(view, event.data ?? "");
    }
    nativeCompositionActive = false;
    brokenCompositionSequence = false;
  };

  dom.addEventListener("compositionstart", handleCompositionStart, true);
  dom.addEventListener("compositionend", handleCompositionEnd, true);
  dom.addEventListener("beforeinput", handleBeforeInput, true);

  return () => {
    dom.removeEventListener("compositionstart", handleCompositionStart, true);
    dom.removeEventListener("compositionend", handleCompositionEnd, true);
    dom.removeEventListener("beforeinput", handleBeforeInput, true);
  };
}

/**
 * Work around WebKit/macOS IME sequences that leave ProseMirror in a permanent
 * composing state and then commit the same Korean composition multiple times.
 */
function installWebKitCompositionWorkaround(view: EditorView): () => void {
  const cleanupSelectionGuard = installCompositionSelectionGuard(view);
  const cleanupInputGuard = installBrokenWebKitInputGuard(view);

  return () => {
    cleanupInputGuard();
    cleanupSelectionGuard();
  };
}

export {
  installCompositionSelectionGuard,
  installWebKitCompositionWorkaround,
  installBrokenWebKitInputGuard,
};
