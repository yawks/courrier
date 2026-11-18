// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { useGoogleEvents } from './useGoogleEvents';
import { useNextcloudEvents } from './useNextcloudEvents';
import { useICSEvents } from './useICSEvents';
import type { CalendarConfig, CalendarEvent } from '../../../shared/types';
import '../../../i18n';

const mocks = vi.hoisted(() => ({
  load: vi.fn(), cached: vi.fn(), save: vi.fn(),
  token: async () => 'fixture-token',
}));
vi.mock('../../../shared/store/GoogleAuthStore', () => ({ useGoogleAuth: () => ({ getValidToken: mocks.token }) }));
vi.mock('../utils/googleCalendarApi', () => ({ listEvents: (...args: unknown[]) => mocks.load(...args) }));
vi.mock('../utils/googleCalendarSync', () => ({ synchronizeGoogleCalendar: (...args: unknown[]) => mocks.load(...args) }));
vi.mock('../utils/icsCalendarSync', () => ({ synchronizeIcsCalendar: (...args: unknown[]) => mocks.load(...args) }));
vi.mock('../../../shared/api/calendarApi', () => ({ calendarApi: { fetchIcs: () => mocks.load() } }));
vi.mock('../utils/parseICS', () => ({ parseICS: (events: unknown) => events }));
vi.mock('../utils/loadCalDavCalendar', () => ({
  loadCalDavCalendar: async () => ({ events: await mocks.load(), readOnly: false }),
  calDavLoadError: (error: Error) => error.message,
}));
vi.mock('../utils/eventCache', async original => ({
  ...await original<typeof import('../utils/eventCache')>(),
  cacheGetStale: mocks.cached, cacheSet: mocks.save, cacheIsFresh: async () => false,
}));

const event: CalendarEvent = { id: 'appointment', calendarId: 'cal', title: 'Fixture', start: '2026-11-18T09:00:00Z', end: '2026-11-18T10:00:00Z', isAllday: false, category: 'time' };
const hooks = { google: useGoogleEvents, nextcloud: useNextcloudEvents, ics: useICSEvents };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.cached.mockResolvedValue(null);
  mocks.save.mockResolvedValue(undefined);
  mocks.load.mockReset();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

it.each(['google', 'nextcloud', 'ics'] as const)('%s keeps visible events when a refresh and the disk cache fail, but accepts a successful empty result', async type => {
  const cal: CalendarConfig = { id: 'cal', type, name: 'Fixture', url: 'https://calendar.example/', color: '#123456', visible: true, googleCalendarId: 'primary', googleAccountId: 'account' };
  let value!: ReturnType<typeof useGoogleEvents | typeof useNextcloudEvents | typeof useICSEvents>;
  const useEvents = hooks[type];
  function Probe() { value = useEvents([cal]); return null; }
  const root = createRoot(document.createElement('div'));
  mocks.load.mockResolvedValue([event]);
  try {
    await act(async () => root.render(<Probe />));
    expect(value.events).toEqual([event]);
    mocks.load.mockRejectedValue(new Error('offline'));
    await act(async () => { await value.refresh(); });
    expect(value.events).toEqual([event]);
    expect(value.errors.cal).toBe('offline');
    expect(value.loading).toBe(false);
    mocks.load.mockResolvedValue([]);
    await act(async () => { await value.refresh(); });
    expect(value.events).toEqual([]);
    expect(value.errors).toEqual({});
  } finally { await act(async () => root.unmount()); }
});

it.each(['google', 'nextcloud', 'ics'] as const)('%s keeps its persisted snapshot when the initial network request fails', async type => {
  const cal: CalendarConfig = { id: 'cal', type, name: 'Fixture', url: 'https://calendar.example/', color: '#123456', visible: true, googleCalendarId: 'primary', googleAccountId: 'account' };
  let value!: ReturnType<typeof useGoogleEvents | typeof useNextcloudEvents | typeof useICSEvents>;
  const useEvents = hooks[type];
  function Probe() { value = useEvents([cal]); return null; }
  const root = createRoot(document.createElement('div'));
  mocks.cached.mockResolvedValue(type === 'nextcloud' ? { events: [event], readOnly: false } : [event]);
  mocks.load.mockRejectedValue(new Error('offline'));
  try {
    await act(async () => root.render(<Probe />));
    expect(value.events).toEqual([event]);
    expect(value.errors.cal).toBe('offline');
    expect(mocks.save).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});
