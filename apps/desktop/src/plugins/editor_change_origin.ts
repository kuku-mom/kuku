import { definePlugin, type Extension } from "prosekit/core";
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosekit/pm/state";

const automaticChange = "kuku.automaticDocumentChange";
const userChanges = new PluginKey<number>("kukuUserDocumentChanges");

/** Machine changes still participate in saving, but are not user typing. */
export function markAutomaticDocumentChange(transaction: Transaction): Transaction {
  return transaction.setMeta(automaticChange, true);
}

function isAutomatic(transaction: Transaction): boolean {
  const root = transaction.getMeta("appendedTransaction") as Transaction | undefined;
  return Boolean(transaction.getMeta(automaticChange) || root?.getMeta(automaticChange));
}

export function createDocumentChangeOriginPlugin(): Plugin<number> {
  return new Plugin({
    key: userChanges,
    state: {
      init: () => 0,
      apply: (transaction, revision) =>
        transaction.docChanged && !isAutomatic(transaction) ? revision + 1 : revision,
    },
  });
}

export function defineDocumentChangeOrigin(): Extension {
  return definePlugin(createDocumentChangeOriginPlugin());
}

export function hasUserDocumentChange(previous: EditorState, next: EditorState): boolean {
  return userChanges.getState(previous) !== userChanges.getState(next);
}
