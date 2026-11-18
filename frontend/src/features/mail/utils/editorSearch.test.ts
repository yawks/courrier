// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import { EditorSearch, editorSearchKey, findEditorMatches } from './editorSearch';

describe('editor search', () => {
  it('finds literal text across formatting, keeps blocks separate, and never serializes highlights', () => {
    const editor = new Editor({ extensions: [StarterKit, EditorSearch], content: '<p>Hello <strong>world</strong> hello WORLD [x]</p><p>Hello</p><p>world</p>' });
    expect(findEditorMatches(editor.state.doc, 'hello world')).toHaveLength(2);
    expect(findEditorMatches(editor.state.doc, '[x]')).toHaveLength(1);
    const html = editor.getHTML();
    editor.view.dispatch(editor.state.tr.setMeta(editorSearchKey, { query: 'hello world', active: 1 }));
    expect(editorSearchKey.getState(editor.state)?.matches).toHaveLength(2);
    expect(editor.view.dom.querySelectorAll('.mail-editor-search-match').length).toBeGreaterThan(1);
    expect(editor.getHTML()).toBe(html);
    editor.commands.insertContentAt(1, 'hello world ');
    expect(editorSearchKey.getState(editor.state)?.matches).toHaveLength(3);
    editor.view.dispatch(editor.state.tr.setMeta(editorSearchKey, { query: '', active: 0 }));
    expect(editor.view.dom.querySelector('.mail-editor-search-match')).toBeNull();
    editor.destroy();
  });
});
