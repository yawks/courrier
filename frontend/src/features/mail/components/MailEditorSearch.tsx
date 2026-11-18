import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/core';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { closeHistory } from '@tiptap/pm/history';
import { editorSearchKey } from '../utils/editorSearch';

export function MailEditorSearch({ editor, children }: { readonly editor: Editor; readonly children?: ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const replacementId = useId();
  const scrollFrameRef = useRef<number | null>(null);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [, refresh] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const replacementRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const search = editorSearchKey.getState(editor.state)!;
  const update = (value: string, active = 0) => {
    editor.view.dispatch(editor.state.tr.setMeta(editorSearchKey, { query: value, active }).setMeta('addToHistory', false));
  };
  const close = () => {
    update('');
    setOpen(false);
    setShowReplace(false);
    setQuery('');
    editor.view.dom.focus({ preventScroll: true });
  };
  useEffect(() => {
    const onTransaction = () => { if (barRef.current) refresh(value => value + 1); };
    editor.on('transaction', onTransaction);
    const onKeyDown = (event: KeyboardEvent) => {
      const scope = editor.view.dom.closest('.mail-composer, .mail-new-composer') ?? editor.view.dom.closest('.mail-editor');
      if (!scope?.contains(event.target as Node)) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && ['f', 'h'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(true);
        if (event.key.toLowerCase() === 'h') setShowReplace(true);
        requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
      } else if (event.key === 'Escape' && barRef.current) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
      editor.off('transaction', onTransaction);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [editor]);
  const revealMatch = (match: { from: number; to: number }) => {
    const dom = editor.view.domAtPos(match.from).node;
    let element = dom instanceof Element ? dom : dom.parentElement;
    while (element && element !== editor.view.dom) {
      if (element.matches('.mail-quoted--editor')) {
        const toggle = element.querySelector<HTMLButtonElement>(':scope > .mail-quoted__toggle[aria-expanded="false"]');
        toggle?.click();
      }
      element = element.parentElement;
    }
    editor.commands.setTextSelection(match);
    // Scroll the highlighted DOM even while focus stays on the search controls.
    // Wait for expanded quotes and selection updates to finish their layout.
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (editor.isDestroyed) return;
      editor.view.dom.querySelector('.mail-editor-search-match--active')?.scrollIntoView({ block: 'center', inline: 'nearest' });
    });
  };
  const navigate = (index: number) => {
    const count = search.matches.length;
    if (!count) return;
    const next = (index + count) % count;
    update(search.query, next);
    const match = search.matches[next];
    revealMatch(match);
  };
  const runSearch = () => {
    if (query === search.query && search.matches.length) navigate(search.active + 1);
    else {
      update(query);
      const first = editorSearchKey.getState(editor.state)?.matches[0];
      if (first) revealMatch(first);
    }
  };
  const replace = (all: boolean) => {
    if (!query) return;
    if (query !== search.query) update(query);
    const current = editorSearchKey.getState(editor.state)!;
    const matches = all ? current.matches : current.matches.slice(current.active, current.active + 1);
    if (!matches.length) return;
    const transaction = closeHistory(editor.state.tr);
    for (const match of [...matches].reverse()) {
      if (replacement) transaction.insertText(replacement, match.from, match.to);
      else transaction.delete(match.from, match.to);
    }
    editor.view.dispatch(transaction.scrollIntoView());
    replacementRef.current?.focus({ preventScroll: true });
  };
  return <>
    <div className="mail-editor-search__toolbar">{children}<button type="button" className="mail-format-btn mail-editor-search__toggle" title={t('mail.findReplace')} aria-label={t('mail.findReplace')} onClick={() => {
      setOpen(true);
      requestAnimationFrame(() => inputRef.current?.focus());
    }}><Search size={16} /></button></div>
    {open && <div ref={barRef} className="mail-editor-search" role="search">
      <div className="mail-editor-search__row">
        <label className="mail-editor-search__field"><span>{t('mail.findInMessage')}</span><input ref={inputRef} type="search" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          event.stopPropagation();
          runSearch();
        }} /></label>
        <div className="mail-editor-search__actions"><button type="button" className="btn-icon" onClick={runSearch} aria-label={t('mail.findInMessage')} title={t('mail.findInMessage')}><Search size={14} /></button>
        <span className="mail-editor-search__count" role="status">{t('mail.findResults', { current: search.matches.length ? search.active + 1 : 0, count: search.matches.length })}</span>
        <button type="button" className="btn-icon" disabled={!search.matches.length} onClick={() => navigate(search.active - 1)} aria-label={t('mail.findPrevious')} title={t('mail.findPrevious')}><ChevronUp size={14} /></button>
        <button type="button" className="btn-icon" disabled={!search.matches.length} onClick={() => navigate(search.active + 1)} aria-label={t('mail.findNext')} title={t('mail.findNext')}><ChevronDown size={14} /></button>
        <button type="button" className="mail-editor-search__link" aria-expanded={showReplace} aria-controls={replacementId} onClick={() => setShowReplace(value => !value)}>{t(showReplace ? 'mail.hideReplace' : 'mail.replace')}</button>
        <button type="button" className="btn-icon" onClick={close} aria-label={t('mail.findClose')} title={t('mail.findClose')}><X size={14} /></button></div>
      </div>
      {showReplace && <div id={replacementId} className="mail-editor-search__row">
        <label className="mail-editor-search__field"><span>{t('mail.replaceWith')}</span><input ref={replacementRef} value={replacement} onChange={event => setReplacement(event.target.value)} onKeyDown={event => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          event.stopPropagation();
          replace(false);
        }} /></label>
        <div className="mail-editor-search__actions"><button type="button" className="btn-ghost" disabled={!query} onClick={() => replace(false)}>{t('mail.replace')}</button>
        <button type="button" className="btn-ghost" disabled={!query} onClick={() => replace(true)}>{t('mail.replaceAll')}</button></div>
      </div>}

    </div>}
  </>;
}
