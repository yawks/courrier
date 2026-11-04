// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SidebarCalendarActions from './SidebarCalendarActions';
import Sidebar from './Sidebar';
import i18n from '../../../i18n';
import type { CalendarConfig } from '../../../shared/types';

vi.mock('./SharedCalendarModal', () => ({ default: ({ onClose }: { onClose: () => void }) => <div role="dialog"><button onClick={onClose}>Close shared form</button></div> }));
vi.mock('../store/CalendarStore', () => ({ useCalendars: () => ({ removeCalendar: vi.fn() }) }));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const panel = () => document.querySelector<HTMLElement>('.calendar-sidebar-actions__popover');
const trigger = () => host.querySelector<HTMLButtonElement>('.calendar-sidebar-actions__trigger')!;

it.each(['fr', 'en'])('opens only on demand, supports Escape, outside click and focus leaving (%s)', async language => {
  await i18n.changeLanguage(language);
  await act(async () => root.render(<SidebarCalendarActions onAddGroup={vi.fn()} />));
  expect(panel()).toBeNull();
  expect(trigger().getAttribute('aria-expanded')).toBe('false');
  await act(async () => trigger().click());
  expect(panel()?.textContent).toContain(i18n.t('sharedCalendars.add'));
  expect(panel()?.textContent).toContain(i18n.t('sidebar.newGroup'));
  expect(document.activeElement).toBe(panel()?.querySelector('button'));
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(panel()).toBeNull();
  expect(document.activeElement).toBe(trigger());
  await act(async () => trigger().click());
  await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(panel()).toBeNull();
  await act(async () => trigger().click());
  const outside = document.createElement('button'); document.body.append(outside);
  await act(async () => outside.focus());
  expect(panel()).toBeNull();
  expect(document.activeElement).toBe(outside);
  outside.remove();
});

it('creates a group inside the popover and restores focus to the compact trigger', async () => {
  const add = vi.fn();
  await act(async () => root.render(<SidebarCalendarActions onAddGroup={add} />));
  await act(async () => trigger().click());
  await act(async () => panel()!.querySelectorAll<HTMLButtonElement>('button')[1].click());
  const input = panel()!.querySelector<HTMLInputElement>('input')!;
  expect(document.activeElement).toBe(input);
  expect(input.closest('label')?.textContent).toBe(i18n.t('sidebar.groupNamePlaceholder'));
  expect(panel()?.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(true);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '  Work  ');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => panel()!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(add).toHaveBeenCalledTimes(1);
  expect(add).toHaveBeenCalledWith('Work');
  expect(panel()).toBeNull();
  expect(document.activeElement).toBe(trigger());
});

it('opens the shared calendar form and returns focus after closing it', async () => {
  await act(async () => root.render(<SidebarCalendarActions onAddGroup={vi.fn()} />));
  await act(async () => trigger().click());
  await act(async () => panel()!.querySelector<HTMLButtonElement>('button')!.click());
  expect(panel()).toBeNull();
  expect(host.textContent).toContain('Close shared form');
  await act(async () => Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Close shared form')!.click());
  expect(document.activeElement).toBe(trigger());
});

it('hides the empty Other calendars group while keeping subscribed shared calendars visible', async () => {
  const props = { groups: [{ id: 'default', name: 'My calendars' }, { id: 'other-calendars', name: 'Other calendars' }],
    onToggle: vi.fn(), onUpdate: vi.fn(), onReorderCalendars: vi.fn(), onAddGroup: vi.fn(), onUpdateGroup: vi.fn(), onRemoveGroup: vi.fn(),
    loading: false, errors: {}, width: 260, currentDate: new Date('2026-11-04'), onNavigateToDate: vi.fn() };
  await act(async () => root.render(<MemoryRouter><Sidebar {...props} calendars={[]} /></MemoryRouter>));
  expect(host.querySelector('.shared-calendar-group')).toBeNull();
  expect(host.querySelectorAll('.calendar-sidebar-actions__trigger')).toHaveLength(1);
  expect(host.textContent).not.toContain(i18n.t('sidebar.newGroup'));
  const shared = { id: 'shared', name: 'Camille', type: 'exchange', visible: true, color: '#888', url: '', shared: { ownerEmail: 'camille@example.test' } } as CalendarConfig;
  await act(async () => root.render(<MemoryRouter><Sidebar {...props} calendars={[shared]} /></MemoryRouter>));
  expect(host.querySelector('.shared-calendar-group')?.textContent).toContain('Camille');
});
