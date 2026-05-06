import { createSignal } from "solid-js";

export type GraphViewMode = "2d" | "3d";

const STORAGE_KEY = "kuku.graph_view.mode";

function readInitialMode(): GraphViewMode {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "3d" ? "3d" : "2d";
  } catch {
    return "2d";
  }
}

const [graphViewMode, setGraphViewModeSignal] = createSignal<GraphViewMode>(readInitialMode());

function setGraphViewMode(mode: GraphViewMode): void {
  setGraphViewModeSignal(mode);
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* storage may be unavailable in restricted contexts */
  }
}

export { graphViewMode, setGraphViewMode };
