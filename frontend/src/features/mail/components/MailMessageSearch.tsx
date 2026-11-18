import { useEffect, useRef, useState, type RefObject } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { clearMailMatches, highlightMailMatches } from '../utils/mailMessageSearch';

export function MailMessageSearch({ blockRef }: { readonly blockRef: RefObject<HTMLDivElement> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<{ index: number; count: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLFormElement>(null);
  const groups = useRef<HTMLElement[][]>([]);
  const submitted = useRef('');

  const clear = () => {
    const root = blockRef.current?.querySelector<HTMLIFrameElement>('.mail-email-body-stage iframe')?.contentDocument?.body;
    if (root) clearMailMatches(root);
    groups.current = [];
    submitted.current = '';
    setResult(null);
  };
  const close = () => {
    clear();
    setQuery('');
    setOpen(false);
    blockRef.current?.querySelector<HTMLIFrameElement>('.mail-email-body-stage iframe')?.focus({ preventScroll: true });
  };

  useEffect(() => {
    const block = blockRef.current;
    if (!block) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('.mail-editor, .mail-composer, .mail-new-composer')) return;
      if (event.key === 'Escape' && barRef.current) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f' || event.altKey) return;
      if (event.defaultPrevented) return;
      // A focused message wins; otherwise use the first visible expanded mail.
      const focused = document.activeElement?.closest('.mail-message-block.expanded');
      const candidates = [...document.querySelectorAll<HTMLElement>('.mail-message-block.expanded')];
      const target = focused ?? candidates.find(el => {
        const rect = el.getBoundingClientRect();
        let parent = el.parentElement;
        while (parent && !/auto|scroll/.test(getComputedStyle(parent).overflowY)) parent = parent.parentElement;
        const pane = parent?.getBoundingClientRect();
        return rect.bottom > (pane?.top ?? 0) + 86 && rect.top < (pane?.bottom ?? window.innerHeight);
      }) ?? candidates[0];
      if (target !== block) return;
      event.preventDefault();
      setOpen(true);
      requestAnimationFrame(() => {
        inputRef.current?.focus({ preventScroll: true });
        inputRef.current?.select();
        barRef.current?.scrollIntoView({ block: 'nearest' });
      });
    };
    const docs = new Set<Document>();
    const bindFrame = () => {
      const doc = block.querySelector<HTMLIFrameElement>('.mail-email-body-stage iframe')?.contentDocument;
      if (!doc || docs.has(doc)) return;
      docs.add(doc);
      doc.addEventListener('keydown', onKeyDown, true);
      const style = doc.createElement('style');
      const theme = getComputedStyle(document.documentElement);
      const darkFilter = doc.defaultView?.getComputedStyle(doc.querySelector('.ew') ?? doc.body).filter;
      style.textContent = `[data-mail-search] { ${darkFilter && darkFilter !== 'none' ? 'filter: url(#dm);' : ''} background: #ffff00; color: #000; } [data-mail-search-active] { outline: 2px solid ${theme.getPropertyValue('--text')}; outline-offset: 1px; }`;
      doc.head.append(style);
      groups.current = [];
      submitted.current = '';
      setResult(null);
    };
    document.addEventListener('keydown', onKeyDown, true);
    block.addEventListener('load', bindFrame, true);
    bindFrame();
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      block.removeEventListener('load', bindFrame, true);
      docs.forEach(doc => {
        doc.removeEventListener('keydown', onKeyDown, true);
        if (doc.body) clearMailMatches(doc.body);
      });
    };
  }, [blockRef]);

  const navigate = (index: number) => {
    const count = groups.current.length;
    if (!count) { setResult({ index: 0, count: 0 }); return; }
    const next = (index + count) % count;
    groups.current.flat().forEach(mark => mark.removeAttribute('data-mail-search-active'));
    groups.current[next].forEach(mark => mark.setAttribute('data-mail-search-active', ''));
    setResult({ index: next, count });
    const mark = groups.current[next][0];
    const frame = blockRef.current?.querySelector<HTMLIFrameElement>('.mail-email-body-stage iframe');
    if (!frame || !mark) return;
    // The iframe grows to fit the mail: scroll the reading pane, not its viewport.
    let pane = blockRef.current?.parentElement;
    while (pane && !/auto|scroll/.test(getComputedStyle(pane).overflowY)) pane = pane.parentElement;
    if (pane) {
      const top = frame.getBoundingClientRect().top + mark.getBoundingClientRect().top;
      pane.scrollTop += top - pane.getBoundingClientRect().top - (barRef.current?.offsetHeight ?? 48) - 66;
    }
  };

  if (!open) return null;
  return <form ref={barRef} className="mail-message-search" role="search" onSubmit={event => {
    event.preventDefault();
    const value = query.trim();
    const root = blockRef.current?.querySelector<HTMLIFrameElement>('.mail-email-body-stage iframe')?.contentDocument?.body;
    if (!root || !value) { clear(); return; }
    if (submitted.current === value && groups.current.length) { navigate((result?.index ?? -1) + 1); return; }
    groups.current = highlightMailMatches(root.querySelector<HTMLElement>('.ew') ?? root, value);
    submitted.current = value;
    navigate(0);
  }}>
    <label className="mail-message-search__field">
      <span>{t('mail.findInMessage')}</span>
      <input ref={inputRef} type="search" value={query} onChange={event => setQuery(event.target.value)} aria-label={t('mail.findInMessage')} />
    </label>
    <button type="submit" className="btn-icon" aria-label={t('mail.findInMessage')} title={t('mail.findInMessage')}><Search size={16} /></button>
    {result && <span className="mail-message-search__count" role="status">{t('mail.findResults', { current: result.count ? result.index + 1 : 0, count: result.count })}</span>}
    {result && <>
      <button type="button" className="btn-icon" disabled={!result.count} onClick={() => navigate(result.index - 1)} aria-label={t('mail.findPrevious')} title={t('mail.findPrevious')}><ChevronUp size={16} /></button>
      <button type="button" className="btn-icon" disabled={!result.count} onClick={() => navigate(result.index + 1)} aria-label={t('mail.findNext')} title={t('mail.findNext')}><ChevronDown size={16} /></button>
    </>}
    <button type="button" className="btn-icon" onClick={close} aria-label={t('mail.findClose')} title={t('mail.findClose')}><X size={16} /></button>
  </form>;
}
