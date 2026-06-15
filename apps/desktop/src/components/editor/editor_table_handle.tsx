import type { Editor } from "prosekit/core";
import {
  TableHandleColumnRoot,
  TableHandleColumnTrigger,
  TableHandleDragPreview,
  TableHandleDropIndicator,
  TableHandlePopoverContent,
  TableHandlePopoverItem,
  TableHandleRoot,
  TableHandleRowRoot,
  TableHandleRowTrigger,
} from "prosekit/solid/table-handle";
import type { JSX } from "solid-js";

import { EllipsisVerticalIcon } from "~/components/icons";
import { t } from "~/i18n";

type EditorCmd = ((...args: unknown[]) => void) & {
  canExec?(...args: unknown[]): boolean;
};

interface EditorTableHandleProps {
  editor: Editor;
}

const COLUMN_HANDLE_CELL_OVERLAP = -6;
const ROW_HANDLE_CELL_OVERLAP = -6;

function getEditorCommands(editor: Editor): Record<string, EditorCmd> {
  return (editor as unknown as { commands: Record<string, EditorCmd> }).commands;
}

function runTableCommand(editor: Editor, commandName: string): void {
  const cmd = getEditorCommands(editor)[commandName];
  if (!cmd || cmd.canExec?.() === false) return;

  cmd();
  requestAnimationFrame(() => editor.view.focus());
}

function TableHandleMenuItem(props: {
  editor: Editor;
  label: string;
  commandName: string;
  danger?: boolean;
}) {
  return (
    <TableHandlePopoverItem
      onSelect={() => runTableCommand(props.editor, props.commandName)}
      class={[
        "flex h-7 w-full cursor-pointer items-center rounded-xs px-2.5 py-0.5 text-[0.8125rem] leading-none outline-none",
        "transition-colors duration-100",
        props.danger
          ? "text-error data-highlighted:bg-error-bg"
          : "text-text-primary/95 data-highlighted:bg-bg-secondary/55",
        "data-disabled:cursor-not-allowed data-disabled:text-text-disabled",
      ].join(" ")}
    >
      <span class="whitespace-nowrap">{props.label}</span>
    </TableHandlePopoverItem>
  );
}

function TableHandleMenuContent(props: { children: JSX.Element }) {
  return (
    <TableHandlePopoverContent
      class={[
        "z-1000 min-w-40 overflow-hidden rounded-sm border border-border/40 bg-bg-elevated p-1.5 outline-none",
        "[box-shadow:var(--shadow-context-surface)]",
      ].join(" ")}
    >
      {props.children}
    </TableHandlePopoverContent>
  );
}

export default function EditorTableHandle(props: EditorTableHandleProps) {
  return (
    <TableHandleRoot editor={props.editor}>
      <TableHandleColumnRoot placement="top" offset={COLUMN_HANDLE_CELL_OVERLAP}>
        <TableHandleColumnTrigger
          title={t("editor.table.menu")}
          aria-label={t("editor.table.menu")}
          class={[
            "group flex h-7 w-9 cursor-grab items-center justify-center text-text-muted outline-none active:cursor-grabbing",
          ].join(" ")}
        >
          <span
            class={[
              "flex h-4 w-7 items-center justify-center rounded-xs border border-border/50 bg-bg-elevated shadow-[0_1px_2px_rgba(0,0,0,0.08)]",
              "transition-colors duration-100 group-hover:border-border group-hover:bg-bg-secondary group-hover:text-text-primary",
            ].join(" ")}
          >
            <EllipsisVerticalIcon size={13} class="rotate-90" />
          </span>
        </TableHandleColumnTrigger>
        <TableHandleMenuContent>
          <TableHandleMenuItem
            editor={props.editor}
            label={t("editor.table.add_column_before")}
            commandName="addTableColumnBefore"
          />
          <TableHandleMenuItem
            editor={props.editor}
            label={t("editor.table.add_column_after")}
            commandName="addTableColumnAfter"
          />
          <TableHandleMenuItem
            editor={props.editor}
            label={t("editor.table.delete_column")}
            commandName="deleteTableColumn"
            danger
          />
        </TableHandleMenuContent>
      </TableHandleColumnRoot>

      <TableHandleRowRoot placement="left" offset={ROW_HANDLE_CELL_OVERLAP}>
        <TableHandleRowTrigger
          title={t("editor.table.menu")}
          aria-label={t("editor.table.menu")}
          class={[
            "group flex h-9 w-7 cursor-grab items-center justify-center text-text-muted outline-none active:cursor-grabbing",
          ].join(" ")}
        >
          <span
            class={[
              "flex h-7 w-4 items-center justify-center rounded-xs border border-border/50 bg-bg-elevated shadow-[0_1px_2px_rgba(0,0,0,0.08)]",
              "transition-colors duration-100 group-hover:border-border group-hover:bg-bg-secondary group-hover:text-text-primary",
            ].join(" ")}
          >
            <EllipsisVerticalIcon size={13} />
          </span>
        </TableHandleRowTrigger>
        <TableHandleMenuContent>
          <TableHandleMenuItem
            editor={props.editor}
            label={t("editor.table.add_row_above")}
            commandName="addTableRowAbove"
          />
          <TableHandleMenuItem
            editor={props.editor}
            label={t("editor.table.add_row_below")}
            commandName="addTableRowBelow"
          />
          <TableHandleMenuItem
            editor={props.editor}
            label={t("editor.table.delete_row")}
            commandName="deleteTableRow"
            danger
          />
        </TableHandleMenuContent>
      </TableHandleRowRoot>

      <TableHandleDropIndicator />
      <TableHandleDragPreview />
    </TableHandleRoot>
  );
}
