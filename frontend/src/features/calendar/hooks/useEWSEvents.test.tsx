// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { useEWSEvents } from './useEWSEvents';
import { CALENDAR_KEYS } from './useCalendarQueries';
import { exchangeCalendarApi } from '../../../shared/api/exchangeCalendarApi';
import type { CalendarConfig } from '../../../shared/types';
import '../../../i18n';

vi.mock('../../../shared/store/ExchangeAuthStore', () => ({ useExchangeAuth: () => ({ getValidToken: async () => 'fixture-token' }) }));
vi.mock('../../../shared/api/exchangeCalendarApi', () => ({ exchangeCalendarApi: { list: vi.fn() } }));
const calendar: CalendarConfig = { id: 'cal', type: 'exchange', exchangeAccountId: 'account', name: 'Calendar', color: '#888', visible: true, url: '' };

it('coalesces overlapping refreshes instead of restarting native requests', async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(CALENDAR_KEYS.events('cal'), []);
  let resolve!: (events: never[]) => void;
  vi.mocked(exchangeCalendarApi.list).mockReset().mockImplementation(() => new Promise(yes => { resolve = yes as typeof resolve; }));
  let value: ReturnType<typeof useEWSEvents>;
  function Probe() { value = useEWSEvents([calendar]); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
    let requests!: Promise<unknown>;
    await act(async () => {
      requests = Promise.all([value.refresh('cal'), value.refresh('cal'), value.refresh()]);
    });
    expect(exchangeCalendarApi.list).toHaveBeenCalledTimes(1);
    await act(async () => { resolve([]); await requests; });
    expect(exchangeCalendarApi.list).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); client.clear(); }
});

it('does not automatically reload a failed calendar on focus, reconnect or another observer mount', async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(exchangeCalendarApi.list).mockReset().mockRejectedValue(new Error('EWS calendar GetItem: ErrorItemNotFound'));
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
    expect(exchangeCalendarApi.list).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount()); client.clear();
    focusManager.setFocused(undefined); onlineManager.setOnline(true);
  }
});
