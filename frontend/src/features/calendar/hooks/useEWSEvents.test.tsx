// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { useEWSEvents } from './useEWSEvents';
import { CALENDAR_KEYS } from './useCalendarQueries';
import { synchronizeEwsCalendar } from '../utils/ewsCalendarSync';
import type { CalendarConfig } from '../../../shared/types';
import { cacheGetStale, cacheSet } from '../utils/eventCache';
import '../../../i18n';

vi.mock('../../../shared/store/ExchangeAuthStore', () => ({ useExchangeAuth: () => ({ getValidToken: async () => 'fixture-token' }) }));
vi.mock('../../../shared/api/exchangeCalendarApi', () => ({ exchangeCalendarApi: { list: vi.fn() } }));
vi.mock('../utils/ewsCalendarSync', () => ({ synchronizeEwsCalendar: vi.fn() }));
vi.mock('../utils/eventCache', () => ({ cacheGetStale: vi.fn(), cacheSet: vi.fn(), patchCachedEventRsvp: vi.fn() }));
const calendar: CalendarConfig = { id: 'cal', type: 'exchange', exchangeAccountId: 'account', name: 'Calendar', color: '#888', visible: true, url: '' };
beforeEach(() => {
  vi.mocked(cacheGetStale).mockReset().mockResolvedValue(null);
  vi.mocked(cacheSet).mockReset().mockResolvedValue(undefined);
});

it('coalesces overlapping refreshes instead of restarting native requests', async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(CALENDAR_KEYS.events('cal'), []);
  let resolve!: (events: never[]) => void;
  vi.mocked(synchronizeEwsCalendar).mockReset().mockImplementation(() => new Promise(yes => { resolve = yes as typeof resolve; }));
  let value: ReturnType<typeof useEWSEvents>;
  function Probe() { value = useEWSEvents([calendar]); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
    let requests!: Promise<unknown>;
    await act(async () => {
      requests = Promise.all([value.refresh('cal'), value.refresh('cal'), value.refresh()]);
    });
    expect(synchronizeEwsCalendar).toHaveBeenCalledTimes(1);
    await act(async () => { resolve([]); await requests; });
    expect(synchronizeEwsCalendar).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); client.clear(); }
});

const savedEvent = { id: 'cal::event', calendarId: 'cal', title: 'Cached appointment', start: '2026-11-18T09:00:00Z', end: '2026-11-18T10:00:00Z', category: 'time', isAllday: false };

it.each(['offline', 'Unauthorized', 'EWS calendar GetItem: ErrorItemNotFound'])('keeps the persisted EWS snapshot after restart when loading fails: %s', async error => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(cacheGetStale).mockResolvedValue([savedEvent]);
  vi.mocked(synchronizeEwsCalendar).mockReset().mockRejectedValue(new Error(error));
  let value!: ReturnType<typeof useEWSEvents>;
  function Probe() { value = useEWSEvents([calendar]); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(value.events).toEqual([savedEvent]);
    expect(value.errors.cal).toBe(error);
    expect(value.loading).toBe(false);
    expect(cacheSet).not.toHaveBeenCalled();
    await act(async () => { await value.refresh(); });
    expect(value.events).toEqual([savedEvent]);
  } finally { await act(async () => root.unmount()); client.clear(); }
});

it('replaces stale EWS data only after success, including a genuinely empty calendar', async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(CALENDAR_KEYS.events('cal'), [savedEvent]);
  vi.mocked(synchronizeEwsCalendar).mockReset().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([]);
  let value!: ReturnType<typeof useEWSEvents>;
  function Probe() { value = useEWSEvents([calendar]); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
    await act(async () => { await value.refresh(); });
    expect(value.events).toEqual([savedEvent]);
    await act(async () => { await value.refresh(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(value.events).toEqual([]);
    expect(cacheSet).toHaveBeenCalledWith('ews-events:ews1:cal', []);
    expect(value.errors).toEqual({});
  } finally { await act(async () => root.unmount()); client.clear(); }
});

it('does not automatically reload a failed calendar on focus, reconnect or another observer mount', async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(synchronizeEwsCalendar).mockReset().mockRejectedValue(new Error('EWS calendar GetItem: ErrorItemNotFound'));
  function Probe() { useEWSEvents([calendar]); return null; }
  const root = createRoot(document.createElement('div'));
  const render = (second: boolean) => root.render(<QueryClientProvider client={client}><Probe />{second && <Probe />}</QueryClientProvider>);
  try {
    await act(async () => { render(false); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(client.getQueryState(CALENDAR_KEYS.events('cal'))?.status).toBe('error');
    await act(async () => {
      focusManager.setFocused(false); focusManager.setFocused(true);
      onlineManager.setOnline(false); onlineManager.setOnline(true);
      render(true);
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(synchronizeEwsCalendar).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount()); client.clear();
    focusManager.setFocused(undefined); onlineManager.setOnline(true);
  }
});
