import { Show } from "solid-js";

import { PlannerSelect } from "./controls";
import { PlannerGlyph } from "./icons";
import { pt } from "./messages";
import type { TaskSort } from "./task_query";
import "./task_search.css";

export function TaskSearch(props: {
  query: string;
  onQuery: (query: string) => void;
  sort: TaskSort;
  onSort: (sort: TaskSort) => void;
}) {
  let input!: HTMLInputElement;
  const clear = () => {
    props.onQuery("");
    input.focus({ preventScroll: true });
  };
  return (
    <div class="planner-task-search" role="search" aria-label={pt("taskSearch")}>
      <div class="planner-task-query">
        <PlannerGlyph name="search" size={13} />
        <input
          ref={input}
          type="search"
          aria-label={pt("taskSearch")}
          placeholder={pt("taskSearch")}
          value={props.query}
          spellcheck={false}
          autocomplete="off"
          onInput={(event) => props.onQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.isComposing || !props.query) return;
            event.preventDefault();
            event.stopPropagation();
            clear();
          }}
        />
        <Show when={props.query}>
          <button
            type="button"
            class="planner-task-search-clear"
            aria-label={pt("clearTaskSearch")}
            title={pt("clearTaskSearch")}
            onClick={clear}
          >
            <PlannerGlyph name="close" size={11} />
          </button>
        </Show>
      </div>
      <div class="planner-task-sort">
        <span>{pt("sortTasks")}</span>
        <PlannerSelect
          label={pt("sortTasks")}
          value={props.sort}
          onChange={(value) => props.onSort(value as TaskSort)}
          options={[
            { value: "due", label: pt("sortDue") },
            { value: "scheduled", label: pt("sortScheduled") },
            { value: "title", label: pt("sortTitle") },
          ]}
          compact
        />
      </div>
    </div>
  );
}
