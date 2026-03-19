import { onCleanup, onMount } from "solid-js";
import { ProseKit, useDocChange, useKeymap } from "prosekit/solid";

import { createKukuEditor, destroyEditor } from "~/components/editor/system/editor_engine";
import { getMarkdownService } from "~/plugins/markdown_service";
import { setContextKey } from "~/plugins/context_keys";
import { markTabDirty } from "~/stores/files";
import { readFileWithChecksum, writeFileWithChecksum } from "~/lib/vault_fs";
import { revealPath, setSelectedPath } from "~/stores/vault";

import "~/styles/editor.css";
import "~/styles/wikilink.css";

interface MarkdownEditorProps {
  tabId: string;
  filePath: string;
}

export default function MarkdownEditor(props: MarkdownEditorProps) {
  const editor = createKukuEditor();
  let disposed = false;
  let settingContent = false;
  let checksum: string | null = null;

  async function loadDocument(): Promise<void> {
    const markdown = getMarkdownService();
    if (!markdown) return;

    try {
      const result = await readFileWithChecksum(props.filePath);
      if (disposed) return;

      settingContent = true;
      editor.setContent(markdown.parse(result.content), "start");
      settingContent = false;

      checksum = result.checksum;
      markTabDirty(props.tabId, false);
    } catch (error) {
      if (disposed) return;
      // oxlint-disable-next-line no-console -- intentional error logging
      console.error("Failed to load document:", error);
    }
  }

  async function saveDocument(): Promise<void> {
    if (!checksum || disposed) return;

    const markdown = getMarkdownService();
    if (!markdown) return;

    const json = editor.getDocJSON();
    const content = markdown.stringify(json);

    try {
      const result = await writeFileWithChecksum(props.filePath, content, checksum);
      if (disposed) return;

      if (result.status === "Written") {
        checksum = result.checksum;
        markTabDirty(props.tabId, false);
      } else {
        // oxlint-disable-next-line no-console -- intentional warning for save conflicts
        console.warn("Save conflict:", result);
      }
    } catch (error) {
      if (disposed) return;
      // oxlint-disable-next-line no-console -- intentional error logging
      console.error("Failed to save document:", error);
    }
  }

  function handleFocusIn() {
    setContextKey("editorTextFocus", true);
  }

  function handleFocusOut(e: FocusEvent) {
    const related = e.relatedTarget as Node | null;
    const container = e.currentTarget as HTMLElement;
    if (!related || !container.contains(related)) {
      setContextKey("editorTextFocus", false);
    }
  }

  onMount(() => {
    setContextKey("editorTextFocus", false);
    setSelectedPath(props.filePath);
    revealPath(props.filePath);
    void loadDocument();
  });

  onCleanup(() => {
    disposed = true;
    setContextKey("editorTextFocus", false);
    destroyEditor();
  });

  useDocChange(
    () => {
      if (settingContent || disposed) return;
      markTabDirty(props.tabId, true);
    },
    { editor },
  );

  useKeymap(
    () => ({
      "Mod-s": () => {
        void saveDocument();
        return true;
      },
    }),
    { editor },
  );

  return (
    <ProseKit editor={editor}>
      <div
        class="size-full overflow-y-auto bg-bg-primary"
        onFocusIn={handleFocusIn}
        onFocusOut={handleFocusOut}
      >
        <div ref={editor.mount} />
      </div>
    </ProseKit>
  );
}
