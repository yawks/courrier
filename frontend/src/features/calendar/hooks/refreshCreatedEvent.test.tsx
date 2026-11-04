// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useGoogleEvents } from './useGoogleEvents';
import { useNextcloudEvents } from './useNextcloudEvents';
import { getCreatedGoogleEvent, listEvents } from '../utils/googleCalendarApi';
import { getCreatedNextcloudEvent } from '../utils/nextcloudCalendarApi';
import { loadCalDavCalendar } from '../utils/loadCalDavCalendar';
import { cacheGetStale, cacheIsFresh, cacheSet } from '../utils/eventCache';
import type { CalendarConfig, CalendarEvent } from '../../../shared/types';

const token = vi.hoisted(() => vi.fn(async () => 'token'));
vi.mock('../../../shared/store/GoogleAuthStore', () => ({ useGoogleAuth: () => ({ getValidToken: token }) }));
vi.mock('../utils/googleCalendarApi', () => ({ getCreatedGoogleEvent: vi.fn(), listEvents: vi.fn() }));
vi.mock('../utils/nextcloudCalendarApi', () => ({ getCreatedNextcloudEvent: vi.fn() }));
vi.mock('../utils/loadCalDavCalendar', () => ({ loadCalDavCalendar: vi.fn(), calDavLoadError: () => 'load failed' }));
vi.mock('../utils/eventCache', async importOriginal => ({ ...await importOriginal<typeof import('../utils/eventCache')>(), cacheGetStale: vi.fn(), cacheIsFresh: vi.fn(), cacheSet: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const old: CalendarEvent = { id: 'old', calendarId: 'cal', sourceId: 'old', title: 'Existing', start: '2026-11-10T10:00:00Z', end: '2026-11-10T11:00:00Z', isAllday: false, category: 'time' };
const saved: CalendarEvent = { ...old, id: 'saved', sourceId: 'saved', title: 'Created' };

it.each(['google', 'nextcloud'] as const)('keeps the %s created event, cache and Android snapshot when an older full refresh finishes later', async type => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  token.mockResolvedValue('token');
  const cal: CalendarConfig = { id: 'cal', type, name: 'Calendar', url: 'https://calendar.example.test/', color: '#888', visible: true, googleCalendarId: 'primary', googleAccountId: 'account' };
  vi.mocked(cacheIsFresh).mockResolvedValue(true);
  vi.mocked(cacheGetStale).mockResolvedValue(type === 'google' ? [old] : { events: [old], readOnly: false });
  vi.mocked(getCreatedGoogleEvent).mockResolvedValue([saved]);
  vi.mocked(getCreatedNextcloudEvent).mockResolvedValue([saved]);
  let finish!: () => void;
  if (type === 'google') vi.mocked(listEvents).mockImplementation(() => new Promise(resolve => { finish = () => resolve([old]); }));
  else vi.mocked(loadCalDavCalendar).mockImplementation(() => new Promise(resolve => { finish = () => resolve({ events: [old], readOnly: false }); }));
  const loaded = vi.fn();
  let value!: ReturnType<typeof useGoogleEvents> | ReturnType<typeof useNextcloudEvents>;
  function Probe() { value = type === 'google' ? useGoogleEvents([cal], loaded) : useNextcloudEvents([cal], loaded); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />));
    expect(value.events).toEqual([old]);
    let refresh!: Promise<unknown>;
    await act(async () => { refresh = value.refresh('cal'); });
    await act(async () => { await value.refreshCreated('cal', 'saved'); });
    expect(value.events).toEqual([old, saved]);
    expect(loaded).toHaveBeenLastCalledWith('cal', [old, saved]);
    expect(cacheSet).toHaveBeenLastCalledWith(expect.any(String), type === 'google' ? [old, saved] : { events: [old, saved], readOnly: false }, true);
    await act(async () => { finish(); await refresh; });
    expect(value.events).toEqual([old, saved]);
    expect(loaded).toHaveBeenLastCalledWith('cal', [old, saved]);
    expect(cacheSet).toHaveBeenCalledTimes(1);
    await act(async () => { await value.refreshCreated('cal', 'saved'); });
    expect(value.events).toEqual([old, saved]);
  } finally { await act(async () => root.unmount()); }
});
