// ── Code Block Node ──
//
// Defines the "codeBlock" node for fenced code blocks with language attribute.
// Provides schema spec, toggle/set/insert commands, input rule, and
// exit keymap (double-Enter to exit code block).
//
// Vendored from ProseKit predefined extension with customizations.
// Shiki syntax highlighting is NOT included — will be added separately.

import {
  defaultBlockAt,
  defineCommands,
  defineKeymap,
  defineNodeSpec,
  insertNode,
  setBlockType,
  setNodeAttrs,
  toggleNode,
  union,
  type Extension,
} from "prosekit/core";
import {
  defineCodeBlockEnterRule as prosekitDefineCodeBlockEnterRule,
  defineCodeBlockInputRule as prosekitDefineCodeBlockInputRule,
} from "prosekit/extensions/code-block";
import { TextSelection } from "prosekit/pm/state";

import { defineCodeMirrorCodeBlockView } from "./code_mirror_node_view";

function defineCodeBlockSpec(): Extension {
  return defineNodeSpec({
    name: "codeBlock",
    content: "text*",
    group: "block",
    code: true,
    defining: true,
    marks: "",
    attrs: {
      language: { default: "" },
    },
    parseDOM: [
      {
        tag: "pre",
        preserveWhitespace: "full",
        getAttrs: (node) => ({
          language:
            extractLanguageFromElement(node) ||
            extractLanguageFromElement(node.querySelector("code")),
        }),
      },
    ],
    toDOM(node) {
      const { language } = node.attrs as { language: string };
      return [
        "pre",
        { "data-language": language || undefined },
        ["code", { class: language ? `language-${language}` : undefined }, 0],
      ];
    },
  });
}

function extractLanguageFromElement(element: Element | null): string {
  if (!element) return "";
  const attr = element.getAttribute("data-language");
  if (attr) return attr;
  const match = /language-(\w+)/.exec(element.className);
  if (match) return match[1];
  return "";
}

function defineCodeBlockCommands(): Extension {
  return defineCommands({
    setCodeBlock: (attrs?: { language?: string }) => setBlockType({ type: "codeBlock", attrs }),
    insertCodeBlock: (attrs?: { language?: string }) => insertNode({ type: "codeBlock", attrs }),
    toggleCodeBlock: (attrs?: { language?: string }) => toggleNode({ type: "codeBlock", attrs }),
    setCodeBlockAttrs: (attrs: { language?: string }) => setNodeAttrs({ type: "codeBlock", attrs }),
  });
}

/**
 * Keymap: pressing Enter at the end of a code block that ends with two
 * newlines exits the code block and inserts a default block below.
 */
function defineCodeBlockKeymap(): Extension {
  return defineKeymap({
    Enter: (state, dispatch) => {
      if (!state.selection.empty) return false;
      const { $head } = state.selection;
      const parent = $head.parent;

      if (
        parent.isTextblock &&
        parent.type.spec.code &&
        $head.parentOffset === parent.content.size &&
        parent.textContent.endsWith("\n\n")
      ) {
        const grandParent = $head.node(-1);
        const insertIndex = $head.indexAfter(-1);
        const type = defaultBlockAt(grandParent.contentMatchAt(insertIndex));
        if (!type || !grandParent.canReplaceWith(insertIndex, insertIndex, type)) return false;

        if (dispatch) {
          const { tr } = state;
          tr.delete($head.pos - 2, $head.pos);
          const pos = tr.selection.$head.after();
          const node = type.createAndFill();
          if (node) {
            tr.replaceWith(pos, pos, node);
            tr.setSelection(TextSelection.near(tr.doc.resolve(pos), 1));
            dispatch(tr.scrollIntoView());
          }
        }
        return true;
      }
      return false;
    },
  });
}

function defineCodeBlock(): Extension {
  return union(
    defineCodeBlockSpec(),
    defineCodeBlockCommands(),
    prosekitDefineCodeBlockInputRule(),
    prosekitDefineCodeBlockEnterRule(),
    defineCodeBlockKeymap(),
    defineCodeMirrorCodeBlockView(),
  );
}

export { defineCodeBlock };
