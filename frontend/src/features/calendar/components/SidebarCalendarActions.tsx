import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderPlus, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import SharedCalendarModal from './SharedCalendarModal';

export default function SidebarCalendarActions({ onAddGroup }: { readonly onAddGroup: (name: string) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [addingGroup, setAddingGroup] = useState(false);
  const [name, setName] = useState('');
  const [sharedOpen, setSharedOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const close = () => { setOpen(false); trigger.current?.focus(); };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current!.getBoundingClientRect();
      const width = Math.min(280, window.innerWidth - 16);
      const height = panel.current!.getBoundingClientRect().height;
      setPosition({
        left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - height - 8)),
      });
    };
    place();
    panel.current?.querySelector<HTMLElement>(addingGroup ? 'input' : 'button')?.focus();
    const outside = (event: Event) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape, true);
    document.addEventListener('scroll', outside, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape, true);
      document.removeEventListener('scroll', outside, true);
      window.removeEventListener('resize', place);
    };
  }, [open, addingGroup]);

  return <>
    <button ref={trigger} type="button" className="btn-ghost calendar-sidebar-actions__trigger"
      aria-label={t('sidebar.calendarActions')} title={t('sidebar.calendarActions')}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { setAddingGroup(false); setName(''); setOpen(value => !value); }}>
      <Plus size={16} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={panel} id={id} role="dialog" aria-label={t('sidebar.calendarActions')}
      className="calendar-sidebar-actions__popover" style={position}>
      {addingGroup ? <form className="calendar-sidebar-actions__form" onSubmit={event => {
        event.preventDefault();
        if (!name.trim()) return;
        onAddGroup(name.trim()); close();
      }}>
        <label className="calendar-sidebar-actions__field">
          <span>{t('sidebar.groupNamePlaceholder')}</span>
          <input value={name} onChange={event => setName(event.target.value)} required autoComplete="off" />
        </label>
        <div className="calendar-sidebar-actions__buttons">
          <button type="submit" className="btn-primary" disabled={!name.trim()}>{t('sidebar.save')}</button>
          <button type="button" className="btn-ghost" onClick={close}>{t('sidebar.cancel')}</button>
        </div>
      </form> : <>
        <button type="button" className="calendar-sidebar-actions__item" onClick={() => { setOpen(false); setSharedOpen(true); }}>
          <Plus size={16} aria-hidden="true" /><span>{t('sharedCalendars.add')}</span>
        </button>
        <button type="button" className="calendar-sidebar-actions__item" onClick={() => setAddingGroup(true)}>
          <FolderPlus size={16} aria-hidden="true" /><span>{t('sidebar.newGroup')}</span>
        </button>
      </>}
    </div>, document.body)}
    {sharedOpen && <SharedCalendarModal onClose={() => { setSharedOpen(false); trigger.current?.focus(); }} />}
  </>;
}
