import { Extension } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface EditorMatch { from: number; to: number }
export function findEditorMatches(doc: Node, query: string): EditorMatch[] {
  if (!query) return [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const matches: EditorMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    const text = node.textBetween(0, node.content.size, '', '\ufffc');
    for (const match of text.matchAll(pattern)) matches.push({ from: pos + 1 + match.index!, to: pos + 1 + match.index! + match[0].length });
    return false;
  });
  return matches;
}
interface SearchState { query: string; active: number; matches: EditorMatch[] }
export const editorSearchKey = new PluginKey<SearchState>('mailEditorSearch');
export const EditorSearch = Extension.create({
  name: 'mailEditorSearch',
  addProseMirrorPlugins() {
    return [new Plugin<SearchState>({
      key: editorSearchKey,
      state: {
        init: () => ({ query: '', active: 0, matches: [] }),
        apply(transaction, previous) {
          const meta = transaction.getMeta(editorSearchKey) as { query: string; active: number } | undefined;
          if (!meta && !transaction.docChanged) return previous;
          const query = meta?.query ?? previous.query;
          const matches = findEditorMatches(transaction.doc, query);
          return { query, matches, active: Math.min(meta?.active ?? previous.active, Math.max(0, matches.length - 1)) };
        },
      },
      props: {
        decorations(state) {
          const search = editorSearchKey.getState(state)!;
          return DecorationSet.create(state.doc, search.matches.map((match, index) => Decoration.inline(match.from, match.to, {
            class: `mail-editor-search-match${index === search.active ? ' mail-editor-search-match--active' : ''}`,
          })));
        },
      },
    })];
  },
});
