// ── Editor Context Menu ──
//
// Right-click context menu for the markdown editor.
// Provides quick access to formatting commands, clipboard operations,
// block transforms ("Turn Into"), and AI-powered editing skills.
//
// Phases:
//   1 — Formatting icon grid + Clipboard
//   2 — Turn Into submenu (block type transforms)
//   3 — AI Skills Pattern B (Explain / Summarize → Chat panel)
//   4 — AI Skills Pattern A (Improve / Proofread / Translate → Chat with prompts)
//   5 — Edit with AI (free-form inline prompt via `onRequestAiEdit` callback)

import { createSignal, type JSX } from "solid-js";
import { ContextMenu as KMenu } from "@kobalte/core/context-menu";

import {
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuGroupLabel,
  ContextMenuIconButton,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "~/components/ui";
import {
  BoldIcon,
  CodeIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ItalicIcon,
  LinkIcon,
  SparklesIcon,
  StrikethroughIcon,
} from "~/components/icons";
import { getActiveEditorInstance } from "~/components/editor/system/editor_engine";
import { getAllCommands } from "~/plugins/commands";
import { sendMessage, setSelectedMode } from "~/plugins/builtin/ai_chat/chat_store";
import { openRightPanelView } from "~/stores/layout";

// ── Types ──

interface EditorContextMenuProps {
  children: JSX.Element;
  /**
   * Callback fired when the user picks "Edit with AI" from the menu.
   * The parent component should show a floating input prompt near the
   * current selection so the user can type a free-form instruction.
   */
  onRequestAiEdit?: () => void;
}

/** Loosely-typed ProseKit command function (with optional canExec guard). */
type EditorCmd = ((...args: unknown[]) => void) & { canExec?(...args: unknown[]): boolean };

// ── AI Skill Prompt Templates ──

const AI_SKILL_PROMPTS: Record<string, (text: string) => string> = {
  // Pattern A — replace-oriented: instruct AI to output ONLY the revised text
  improve: (text) =>
    `Improve the writing quality of the following text. ` +
    `Keep the same meaning and tone, but make it clearer and more polished. ` +
    `Output ONLY the improved text without any explanation.\n\n${text}`,

  proofread: (text) =>
    `Proofread the following text. Fix grammar, spelling, and punctuation errors only. ` +
    `Do not change the meaning or style. ` +
    `Output ONLY the corrected text without any explanation.\n\n${text}`,

  translate: (text) =>
    `Translate the following text. ` +
    `If the text is in Korean, translate it to English. ` +
    `If the text is in English, translate it to Korean. ` +
    `Output ONLY the translation without any explanation.\n\n${text}`,

  // Pattern B — conversational: answer appears in the chat panel
  explain: (text) =>
    `Explain the following text in detail. ` +
    `Break it down so it is easy to understand.\n\n${text}`,

  summarize: (text) =>
    `Summarize the following text concisely. ` +
    `Capture the key points in a few sentences.\n\n${text}`,
};

// ── Helpers ──

/**
 * Safely retrieve the commands map from the active ProseKit editor.
 * Returns null when no editor is mounted.
 */
function getEditorCommands(): Record<string, EditorCmd> | null {
  const editor = getActiveEditorInstance();
  if (!editor) return null;
  return (editor as unknown as { commands: Record<string, EditorCmd> }).commands;
}

/** Focus the editor after the context menu finishes closing. */
function queueEditorFocusRestore(): void {
  requestAnimationFrame(() => {
    getActiveEditorInstance()?.view?.focus();
  });
}

/**
 * Get the plain text of the current selection.
 * Returns null when the selection is collapsed (cursor-only).
 */
function getSelectedText(): string | null {
  const editor = getActiveEditorInstance();
  if (!editor?.view) return null;

  const { from, to, empty } = editor.view.state.selection;
  if (empty) return null;

  return editor.view.state.doc.textBetween(from, to, "\n");
}

/**
 * Check whether a mark is active at the current selection.
 *
 * - Empty selection → checks stored marks / marks at cursor.
 * - Range selection → checks whether the range contains the mark.
 */
function isMarkActive(markName: string): boolean {
  const editor = getActiveEditorInstance();
  if (!editor?.view) return false;

  const state = editor.view.state;
  const markType = state.schema.marks[markName];
  if (!markType) return false;

  const { from, $from, to, empty } = state.selection;
  if (empty) {
    return Boolean(markType.isInSet(state.storedMarks || $from.marks()));
  }
  return state.doc.rangeHasMark(from, to, markType);
}

/**
 * Get the heading level of the block containing the cursor.
 * Returns 0 when the cursor is not inside a heading node.
 */
function getActiveHeadingLevel(): number {
  const editor = getActiveEditorInstance();
  if (!editor?.view) return 0;

  const { $from } = editor.view.state.selection;
  const parent = $from.parent;
  return parent.type.name === "heading" ? (parent.attrs.level as number) : 0;
}

/**
 * Get the block type name of the node containing the cursor.
 * Used to highlight the active item in the "Turn Into" submenu.
 */
function getActiveBlockType(): string {
  const editor = getActiveEditorInstance();
  if (!editor?.view) return "paragraph";

  const { $from } = editor.view.state.selection;
  return $from.parent.type.name;
}

/**
 * Detect the list kind at the current cursor position.
 * Returns "bullet", "ordered", "task", or null.
 */
function getActiveListKind(): string | null {
  const editor = getActiveEditorInstance();
  if (!editor?.view) return null;

  const { $from } = editor.view.state.selection;
  // Walk up the tree to find a list node
  for (let depth = $from.depth; depth >= 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === "list") {
      return (node.attrs.kind as string) ?? "bullet";
    }
  }
  return null;
}

/** Check whether the AI chat plugin is registered. */
function isAiChatAvailable(): boolean {
  return getAllCommands().some((reg) => reg.contribution.id === "ai-chat.openPanel");
}

// ── Component ──

export default function EditorContextMenu(props: EditorContextMenuProps) {
  // Snapshot signals — captured once when the menu opens so item states
  // remain stable while the menu is visible.
  const [hasSelection, setHasSelection] = createSignal(false);
  const [activeMarks, setActiveMarks] = createSignal<Set<string>>(new Set());
  const [headingLevel, setHeadingLevel] = createSignal(0);
  const [blockType, setBlockType] = createSignal("paragraph");
  const [listKind, setListKind] = createSignal<string | null>(null);

  // ── State Snapshot ──

  /** Capture the editor's selection and formatting state. */
  function snapshotEditorState(): void {
    const editor = getActiveEditorInstance();
    if (!editor?.view) return;

    const { empty } = editor.view.state.selection;
    setHasSelection(!empty);

    // Active inline marks
    const marks = new Set<string>();
    for (const name of ["bold", "italic", "strike", "code", "link"]) {
      if (isMarkActive(name)) marks.add(name);
    }
    setActiveMarks(marks);

    // Block-level state
    setHeadingLevel(getActiveHeadingLevel());
    setBlockType(getActiveBlockType());
    setListKind(getActiveListKind());
  }

  function handleOpenChange(open: boolean): void {
    if (open) {
      snapshotEditorState();
    }
  }

  // ── Formatting Actions (Phase 1) ──

  /** Toggle an inline mark via its ProseKit command name (e.g. "toggleBold"). */
  function toggleMark(commandName: string): void {
    const cmds = getEditorCommands();
    const cmd = cmds?.[commandName];
    if (!cmd) return;
    cmd();
    queueEditorFocusRestore();
  }

  /** Toggle a heading level (1–6). Calling with the current level removes it. */
  function toggleHeading(level: number): void {
    const cmds = getEditorCommands();
    const cmd = cmds?.toggleHeading;
    if (!cmd) return;
    cmd({ level });
    queueEditorFocusRestore();
  }

  /**
   * Toggle a link mark.
   *
   * - If the selection is already inside a link, remove it.
   * - Otherwise prompt for a destination URL before applying the mark.
   */
  function toggleLink(): void {
    const cmds = getEditorCommands();
    if (!cmds) return;

    if (activeMarks().has("link")) {
      cmds.removeLink?.();
      queueEditorFocusRestore();
      return;
    }

    if (!hasSelection()) return;

    const href = window.prompt("Enter link URL", "https://")?.trim();
    if (!href) {
      queueEditorFocusRestore();
      return;
    }

    cmds.toggleLink?.({ href });
    queueEditorFocusRestore();
  }

  // ── Block Transform Actions (Phase 2) ──

  /** Convert the current block to a paragraph (removing heading / code block / etc.). */
  function turnIntoParagraph(): void {
    const cmds = getEditorCommands();
    if (!cmds) return;

    const bt = blockType();
    const hl = headingLevel();

    // If inside a heading, toggle it off (→ paragraph)
    if (bt === "heading" && hl > 0) {
      cmds.toggleHeading?.({ level: hl });
    } else if (bt === "codeBlock") {
      cmds.toggleCodeBlock?.();
    }

    // If inside a blockquote, unwrap it
    if (isInsideBlockquote()) {
      cmds.toggleBlockquote?.();
    }

    // If inside a list, unwrap it
    if (listKind() !== null) {
      cmds.unwrapList?.();
    }

    queueEditorFocusRestore();
  }

  function turnIntoHeading(level: number): void {
    toggleHeading(level);
  }

  function turnIntoBlockquote(): void {
    const cmds = getEditorCommands();
    if (!cmds) return;
    cmds.toggleBlockquote?.();
    queueEditorFocusRestore();
  }

  function turnIntoCodeBlock(): void {
    const cmds = getEditorCommands();
    if (!cmds) return;
    cmds.toggleCodeBlock?.();
    queueEditorFocusRestore();
  }

  function turnIntoList(kind: "bullet" | "ordered"): void {
    const cmds = getEditorCommands();
    if (!cmds) return;
    cmds.toggleList?.({ kind });
    queueEditorFocusRestore();
  }

  /** Walk up ancestors to check for a blockquote wrapper. */
  function isInsideBlockquote(): boolean {
    const editor = getActiveEditorInstance();
    if (!editor?.view) return false;
    const { $from } = editor.view.state.selection;
    for (let d = $from.depth; d >= 0; d--) {
      if ($from.node(d).type.name === "blockquote") return true;
    }
    return false;
  }

  // ── Clipboard Actions (Phase 1) ──

  function handleClipboard(action: "cut" | "copy" | "paste"): void {
    requestAnimationFrame(() => {
      const editor = getActiveEditorInstance();
      if (!editor?.view) return;
      editor.view.focus();
      document.execCommand(action);
    });
  }

  // ── AI Skill Actions (Phase 3 + 4) ──

  /**
   * Send an AI skill request to the chat panel.
   *
   * 1. Gets the selected text from the editor.
   * 2. Builds a prompt from the skill template.
   * 3. Opens the AI Chat panel.
   * 4. Sets chat mode to "ask" and sends the prompt.
   *
   * Pattern A skills (improve, proofread, translate) instruct the AI to
   * output only the replacement text — the user can copy-paste the result.
   *
   * Pattern B skills (explain, summarize) produce a conversational answer
   * that appears naturally in the chat panel.
   */
  async function handleAiSkill(skill: string): Promise<void> {
    if (!isAiChatAvailable()) return;

    const selected = getSelectedText();
    if (!selected) return;

    const buildPrompt = AI_SKILL_PROMPTS[skill];
    if (!buildPrompt) return;

    const prompt = buildPrompt(selected);

    // Open the AI chat panel and ensure "ask" mode
    openRightPanelView("ai-chat.panel");
    setSelectedMode("ask");

    // Small delay to let the panel mount before sending
    await new Promise((r) => setTimeout(r, 80));

    try {
      await sendMessage(prompt);
    } catch {
      // If sending fails the chat panel will show the error state.
    }
  }

  // ── Edit with AI (Phase 5) ──

  /**
   * Trigger the inline "Edit with AI" flow.
   *
   * Instead of sending a preset prompt, this notifies the parent component
   * (via the `onRequestAiEdit` prop) that the floating instruction input
   * should appear near the current selection. The actual prompt composition
   * and AI invocation happen in the floating input component.
   */
  function handleEditWithAi(): void {
    if (!isAiChatAvailable()) return;
    props.onRequestAiEdit?.();
  }

  // ── Render ──

  return (
    <KMenu onOpenChange={handleOpenChange}>
      <KMenu.Trigger class="contents">{props.children}</KMenu.Trigger>

      <ContextMenuContent class="w-56">
        {/* ── Inline Mark Toggles (Phase 1) ── */}
        <div class="flex items-center gap-0.5 px-1 pt-1 pb-0.5">
          <ContextMenuIconButton
            onSelect={() => toggleMark("toggleBold")}
            active={activeMarks().has("bold")}
            title="Bold (⌘B)"
          >
            <BoldIcon size={15} />
          </ContextMenuIconButton>

          <ContextMenuIconButton
            onSelect={() => toggleMark("toggleItalic")}
            active={activeMarks().has("italic")}
            title="Italic (⌘I)"
          >
            <ItalicIcon size={15} />
          </ContextMenuIconButton>

          <ContextMenuIconButton
            onSelect={() => toggleMark("toggleStrike")}
            active={activeMarks().has("strike")}
            title="Strikethrough"
          >
            <StrikethroughIcon size={15} />
          </ContextMenuIconButton>

          <ContextMenuIconButton
            onSelect={() => toggleMark("toggleCode")}
            active={activeMarks().has("code")}
            title="Inline Code (⌘E)"
          >
            <CodeIcon size={15} />
          </ContextMenuIconButton>

          <ContextMenuIconButton
            onSelect={toggleLink}
            active={activeMarks().has("link")}
            disabled={!hasSelection() && !activeMarks().has("link")}
            title="Link"
          >
            <LinkIcon size={15} />
          </ContextMenuIconButton>
        </div>

        {/* ── Heading Level Toggles (Phase 1) ── */}
        <div class="flex items-center gap-0.5 px-1 pb-1">
          <ContextMenuIconButton
            onSelect={() => toggleHeading(1)}
            active={headingLevel() === 1}
            title="Heading 1 (⌘⌥1)"
          >
            <Heading1Icon size={15} />
          </ContextMenuIconButton>

          <ContextMenuIconButton
            onSelect={() => toggleHeading(2)}
            active={headingLevel() === 2}
            title="Heading 2 (⌘⌥2)"
          >
            <Heading2Icon size={15} />
          </ContextMenuIconButton>

          <ContextMenuIconButton
            onSelect={() => toggleHeading(3)}
            active={headingLevel() === 3}
            title="Heading 3 (⌘⌥3)"
          >
            <Heading3Icon size={15} />
          </ContextMenuIconButton>
        </div>

        <ContextMenuSeparator />

        {/* ── Turn Into (Phase 2) ── */}
        <ContextMenuSub>
          <ContextMenuSubTrigger label="Turn Into" />
          <ContextMenuSubContent>
            <ContextMenuItem
              label="Paragraph"
              onSelect={turnIntoParagraph}
              disabled={blockType() === "paragraph" && headingLevel() === 0 && listKind() === null}
            />
            <ContextMenuSeparator />
            <ContextMenuItem
              label="Heading 1"
              onSelect={() => turnIntoHeading(1)}
              disabled={headingLevel() === 1}
            />
            <ContextMenuItem
              label="Heading 2"
              onSelect={() => turnIntoHeading(2)}
              disabled={headingLevel() === 2}
            />
            <ContextMenuItem
              label="Heading 3"
              onSelect={() => turnIntoHeading(3)}
              disabled={headingLevel() === 3}
            />
            <ContextMenuItem
              label="Heading 4"
              onSelect={() => turnIntoHeading(4)}
              disabled={headingLevel() === 4}
            />
            <ContextMenuItem
              label="Heading 5"
              onSelect={() => turnIntoHeading(5)}
              disabled={headingLevel() === 5}
            />
            <ContextMenuItem
              label="Heading 6"
              onSelect={() => turnIntoHeading(6)}
              disabled={headingLevel() === 6}
            />
            <ContextMenuSeparator />
            <ContextMenuItem label="Blockquote" onSelect={turnIntoBlockquote} />
            <ContextMenuItem
              label="Code Block"
              onSelect={turnIntoCodeBlock}
              disabled={blockType() === "codeBlock"}
            />
            <ContextMenuSeparator />
            <ContextMenuItem
              label="Bullet List"
              onSelect={() => turnIntoList("bullet")}
              disabled={listKind() === "bullet"}
            />
            <ContextMenuItem
              label="Ordered List"
              onSelect={() => turnIntoList("ordered")}
              disabled={listKind() === "ordered"}
            />
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuSeparator />

        {/* ── Clipboard (Phase 1) ── */}
        <ContextMenuItem
          label="Cut"
          shortcut="⌘X"
          onSelect={() => handleClipboard("cut")}
          disabled={!hasSelection()}
        />
        <ContextMenuItem
          label="Copy"
          shortcut="⌘C"
          onSelect={() => handleClipboard("copy")}
          disabled={!hasSelection()}
        />
        <ContextMenuItem label="Paste" shortcut="⌘V" onSelect={() => handleClipboard("paste")} />

        <ContextMenuSeparator />

        {/* ── AI Skills (Phase 3 + 4) ── */}
        <ContextMenuGroup>
          <ContextMenuGroupLabel>
            <span class="flex items-center gap-1.5">
              <SparklesIcon size={11} />
              AI Skills
            </span>
          </ContextMenuGroupLabel>

          <ContextMenuItem
            label="Improve Writing"
            onSelect={() => void handleAiSkill("improve")}
            disabled={!hasSelection() || !isAiChatAvailable()}
          />
          <ContextMenuItem
            label="Proofread"
            onSelect={() => void handleAiSkill("proofread")}
            disabled={!hasSelection() || !isAiChatAvailable()}
          />
          <ContextMenuItem
            label="Explain"
            onSelect={() => void handleAiSkill("explain")}
            disabled={!hasSelection() || !isAiChatAvailable()}
          />
          <ContextMenuItem
            label="Summarize"
            onSelect={() => void handleAiSkill("summarize")}
            disabled={!hasSelection() || !isAiChatAvailable()}
          />
          <ContextMenuItem
            label="Translate"
            onSelect={() => void handleAiSkill("translate")}
            disabled={!hasSelection() || !isAiChatAvailable()}
          />
        </ContextMenuGroup>

        <ContextMenuSeparator />

        {/* ── Edit with AI — free-form (Phase 5) ── */}
        <ContextMenuItem
          label="Edit with AI"
          shortcut="⌘⌃E"
          onSelect={handleEditWithAi}
          disabled={!isAiChatAvailable()}
        />
      </ContextMenuContent>
    </KMenu>
  );
}
