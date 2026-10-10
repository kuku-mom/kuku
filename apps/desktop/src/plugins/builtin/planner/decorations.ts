import { definePlugin } from 'prosekit/core';
import { Plugin } from 'prosekit/pm/state';
import { Decoration, DecorationSet } from 'prosekit/pm/view';

import type { TaskMetadata } from '~/lib/planner_tasks';

import { hasOnlyPlannerLinks } from './links';
import { pt } from './messages';

export function plannerDecorations() {
  return definePlugin(
    new Plugin({
      props: {
        decorations(state) {
          const widgets: Decoration[] = [];
          state.doc.descendants((node, pos) => {
            if (
              node.type.name === 'kukuFrontmatter' &&
              hasOnlyPlannerLinks(String(node.attrs.value ?? ''))
            ) {
              widgets.push(
                Decoration.node(pos, pos + node.nodeSize, { class: 'planner-link-metadata' }),
              );
              widgets.push(
                Decoration.widget(
                  pos + node.nodeSize,
                  () => {
                    const label = document.createElement('div');
                    label.className = 'planner-linked-note-label';
                    label.contentEditable = 'false';
                    label.textContent = pt('linkedCalendarNote');
                    return label;
                  },
                  { key: 'planner-linked-note', ignoreSelection: true },
                ),
              );
            }
            if (node.type.name !== 'list' || !node.attrs.taskMetadata) return;
            const metadata = node.attrs.taskMetadata as TaskMetadata;
            const date = metadata.dueDate ?? metadata.plannedDate;
            if (!date || !node.firstChild) return;
            widgets.push(
              Decoration.widget(
                pos + 1 + node.firstChild.nodeSize - 1,
                () => {
                  const chip = document.createElement('span');
                  chip.className = 'kuku-task-date';
                  chip.contentEditable = 'false';
                  chip.textContent = `${metadata.dueDate ? pt('dueDate') : pt('plannedDate')} ${date}`;
                  return chip;
                },
                { side: -1, key: `${metadata.id}:${date}`, ignoreSelection: true },
              ),
            );
          });
          return DecorationSet.create(state.doc, widgets);
        },
      },
    }),
  );
}
