// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import i18n from '../../../i18n';
import LocationInput from './LocationInput';
import { discoverCalendarRooms, searchCalendarRoomDirectory, type CalendarRoom } from '../utils/roomDiscovery';
import type { CalendarConfig } from '../../../shared/types';
import { queryRoomAvailability, type RoomAvailability } from '../utils/roomAvailability';

vi.mock('../utils/roomDiscovery', () => ({ discoverCalendarRooms: vi.fn(), searchCalendarRoomDirectory: vi.fn().mockResolvedValue([]) }));
vi.mock('../utils/roomAvailability', () => ({ queryRoomAvailability: vi.fn().mockResolvedValue({}) }));
const calendar: CalendarConfig = { id: 'exchange', type: 'exchange', name: 'Calendar', color: '', url: '', visible: true };
const rooms = [{ id: '1', name: 'Room A', email: 'a@example.test' }, { id: '2', name: 'Room B', email: 'b@example.test' }];
afterEach(() => { vi.clearAllMocks(); });

it('rechecks availability on time changes and never shows a stale free status', async () => {
  vi.useFakeTimers();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(discoverCalendarRooms).mockResolvedValue(rooms);
  let finish!: (values: Record<string, RoomAvailability>) => void;
  vi.mocked(queryRoomAvailability)
    .mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce({ 'a@example.test': 'busy', 'b@example.test': 'free' });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const render = (start: string, end: string) => root.render(<LocationInput calendar={calendar} value="" onChange={vi.fn()} start={start} end={end} />);
  try {
    await act(async () => render('2026-10-27T10:00:00Z', '2026-10-27T11:00:00Z'));
    await act(async () => host.querySelector('input')!.focus());
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    await act(async () => render('2026-10-27T12:00:00Z', '2026-10-27T13:00:00Z'));
    await act(async () => { finish({ 'a@example.test': 'free' }); });
    expect(host.querySelector('[role="option"]')?.textContent).not.toContain(i18n.t('createEvent.roomAvailability.free'));
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(host.querySelector('[role="option"]')?.textContent).toContain(i18n.t('createEvent.roomAvailability.busy'));
    expect(queryRoomAvailability).toHaveBeenLastCalledWith(calendar, ['a@example.test', 'b@example.test'], new Date('2026-10-27T12:00:00Z'), new Date('2026-10-27T13:00:00Z'), expect.anything());
    expect(host.textContent).not.toContain('a@example.test');
  } finally { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); }
});

it('searches EWS while typing when room lists are empty and ignores superseded results', async () => {
  vi.useFakeTimers();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(discoverCalendarRooms).mockResolvedValue([]);
  let finish!: (rooms: CalendarRoom[]) => void;
  vi.mocked(searchCalendarRoomDirectory)
    .mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce([{ id: 'b', email: 'b@example.test', name: 'Building B', directory: true }]);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Form />));
    const input = host.querySelector('input')!;
    await act(async () => input.focus());
    const type = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await type('B');
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(searchCalendarRoomDirectory).not.toHaveBeenCalled();
    await type('Building A');
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    await type('Building B');
    await act(async () => { finish([{ id: 'a', name: 'Building A', directory: true }]); await vi.advanceTimersByTimeAsync(350); });
    expect(host.querySelector('[role="option"]')?.textContent).toContain('Building B');
    expect(host.querySelector('[role="option"]')?.textContent).not.toContain('b@example.test');
    expect(host.querySelector('[role="option"]')?.textContent).not.toContain('Exchange');
    expect(host.textContent).not.toContain('Building A');
    expect(searchCalendarRoomDirectory).toHaveBeenCalledTimes(2);
  } finally { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); }
});

function Form({ cal = calendar }: { cal?: CalendarConfig }) {
  const [value, setValue] = useState('');
  return <><label htmlFor="ev-location">Location</label><LocationInput key={cal.id} calendar={cal} value={value} onChange={setValue} /><button>Save</button></>;
}

it.each(['fr', 'en'])('loads on focus and supports keyboard selection and dismissal (%s)', async language => {
  await i18n.changeLanguage(language);
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(discoverCalendarRooms).mockResolvedValue(rooms);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Form />));
    expect(discoverCalendarRooms).not.toHaveBeenCalled();
    const input = host.querySelector('input')!;
    await act(async () => input.focus());
    expect(discoverCalendarRooms).toHaveBeenCalledOnce();
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(host.querySelector('p')?.textContent).toBe(i18n.t('createEvent.roomLocationOnly'));
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(input.getAttribute('aria-activedescendant')).toBe(host.querySelector('[aria-selected="true"]')?.id);
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(input.value).toBe('Room A');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(input);
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => { input.dispatchEvent(escape); });
    expect(escape.defaultPrevented).toBe(true);
    expect(input.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { host.querySelector('button')!.focus(); input.focus(); });
    expect(discoverCalendarRooms).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it('discards late results from a previous calendar and keeps free-text entry when discovery is empty', async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  let finish!: (rooms: CalendarRoom[]) => void;
  vi.mocked(discoverCalendarRooms).mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce([]);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Form />));
    await act(async () => host.querySelector('input')!.focus());
    await act(async () => root.render(<Form cal={{ ...calendar, id: 'google', type: 'google' }} />));
    await act(async () => { finish(rooms); host.querySelector('input')!.focus(); });
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    const input = host.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Outside office');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input.value).toBe('Outside office');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('button')!.disabled).toBe(false);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
