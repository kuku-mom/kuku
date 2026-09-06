import { createSignal, type Accessor, type Setter } from "solid-js";

import type { PlannerTask } from "~/lib/planner_tasks";
import { vaultState } from "~/stores/vault";

import type { PlannerService } from "./service";
import { externalKey, type ExternalItem } from "./types";

export type PlannerSelection = PlannerTask | ExternalItem | null;

const selections = new WeakMap<
  PlannerService,
  [Accessor<PlannerSelection>, Setter<PlannerSelection>]
>();
const selectionVaults = new WeakMap<PlannerService, string | null>();

function selectionFor(service: PlannerService) {
  let selection = selections.get(service);
  if (!selection) {
    selection = createSignal<PlannerSelection>(null);
    selections.set(service, selection);
  }
  return selection;
}

export function setPlannerSelection(service: PlannerService, item: PlannerSelection) {
  selectionVaults.set(service, vaultState.rootPath);
  selectionFor(service)[1](item);
}

export function plannerSelection(service: PlannerService): PlannerSelection {
  const selection = selectionFor(service)[0]();
  if (selectionVaults.get(service) !== vaultState.rootPath) return null;
  if (!selection) return null;
  if ("path" in selection) {
    const matches = service.state.tasks.filter((task) =>
      selection.metadata?.id
        ? task.metadata?.id === selection.metadata.id
        : task.path === selection.path && task.id === selection.id,
    );
    // Never leave a stale, deleted or ambiguously copied task actionable.
    return matches.length === 1 ? matches[0] : null;
  }
  if (!service.state.preferences.enabledSources[selection.provider]) return null;
  if (!service.state.sources[selection.provider].status.connected) return null;
  if (
    !service.state.preferences.selectedCalendars[selection.provider].includes(selection.calendarId)
  )
    return null;
  if (
    !service
      .visibleCalendars(selection.provider)
      .some((calendar) => calendar.id === selection.calendarId)
  )
    return null;
  return (
    service.state.sources[selection.provider].items.find(
      (item) => externalKey(item) === externalKey(selection),
    ) ?? selection
  );
}
