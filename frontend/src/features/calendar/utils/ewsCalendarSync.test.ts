import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { synchronizeEwsCalendar } from './ewsCalendarSync';
import { calendarSourceFingerprint, calendarSyncCacheKey, calendarSyncRange } from './calendarSync';
import { exchangeCalendarApi } from '../../../shared/api/exchangeCalendarApi';
import type { CalendarConfig, CalendarEvent } from '../../../shared/types';

const cache = vi.hoisted(() => new Map<string, unknown>());
vi.mock('./eventCache', () => ({
  cacheGetStale: async (key: string) => structuredClone(cache.get(key) ?? null),
  cacheSet: async (key: string, value: unknown) => { cache.set(key, structuredClone(value)); },
}));
vi.mock('../../../shared/api/exchangeCalendarApi', () => ({ exchangeCalendarApi: { delta: vi.fn(), inventory: vi.fn() } }));
const cal: CalendarConfig = { id: 'ews', name: 'Fixture', url: '', type: 'exchange', color: '#123456', visible: true, exchangeAccountId: 'account' };
const event = (id: string, version = 'v1', year = 2026): CalendarEvent => ({
  id: `ews::${id}`, calendarId: 'ews', sourceId: `${id}|${version}`, title: id,
  start: `${year}-11-18T10:00:00Z`, end: `${year}-11-18T11:00:00Z`, category: 'time', isAllday: false,
});
const convert = (event: CalendarEvent) => event;
const key = calendarSyncCacheKey('exchange', cal.id);
async function seed(events: CalendarEvent[]) {
  cache.set(key, { source: await calendarSourceFingerprint(cal), range: calendarSyncRange(), syncState: 'cursor1',
    versions: Object.fromEntries(events.map(event => event.sourceId!.split('|'))), events });
}
beforeEach(() => {
  cache.clear(); vi.resetAllMocks();
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-18T12:00:00Z'));
  vi.mocked(exchangeCalendarApi.delta).mockResolvedValue({ syncState: 'cursor2', changed: true, reset: false });
  vi.mocked(exchangeCalendarApi.inventory).mockResolvedValue({ events: [], versions: {} });
});
afterEach(() => vi.useRealTimers());

it('skips every CalendarView/GetItem when the folder delta reports no changes', async () => {
  await seed([event('saved')]);
  vi.mocked(exchangeCalendarApi.delta).mockResolvedValue({ syncState: 'cursor2', changed: false, reset: false });
  expect(await synchronizeEwsCalendar(cal, 'token', convert)).toEqual([event('saved')]);
  expect(exchangeCalendarApi.inventory).not.toHaveBeenCalled();
  expect(exchangeCalendarApi.delta).toHaveBeenCalledWith(expect.objectContaining({ syncState: 'cursor1' }));
});

it('loads multiple years progressively, current month first, before committing a cursor', async () => {
  const progress = vi.fn();
  vi.mocked(exchangeCalendarApi.inventory).mockImplementation(async request => {
    expect(cache.has(key)).toBe(false);
    const year = new Date(request.start as string).getUTCFullYear();
    return { events: [event(String(year), 'v1', year)], versions: { [String(year)]: 'v1' } } as never;
  });
  const result = await synchronizeEwsCalendar(cal, 'token', convert, [], progress);
  expect(exchangeCalendarApi.inventory).toHaveBeenCalledTimes(20);
  expect(vi.mocked(exchangeCalendarApi.inventory).mock.calls[0][0].start).toBe('2026-11-01T00:00:00.000Z');
  expect(result).toHaveLength(9);
  expect(progress).toHaveBeenCalledTimes(20);
  expect(cache.has(key)).toBe(true);
});

it('reconciles creates, updates and deletions using complete inventories and known versions', async () => {
  await seed([event('same'), event('changed'), event('deleted')]);
  vi.mocked(exchangeCalendarApi.inventory).mockImplementation(async request => ({
    events: request.start === '2026-01-01T00:00:00.000Z' ? [event('changed', 'v2'), event('new')] : [],
    versions: request.start === '2026-01-01T00:00:00.000Z' ? { same: 'v1', changed: 'v2', new: 'v1' } : {},
  }) as never);
  const result = await synchronizeEwsCalendar(cal, 'token', convert);
  expect(result.map(event => event.sourceId).sort()).toEqual(['changed|v2', 'new|v1', 'same|v1']);
  expect(vi.mocked(exchangeCalendarApi.inventory).mock.calls[0][0].knownVersions).toEqual({ same: 'v1', changed: 'v1', deleted: 'v1' });
});

it('retains the previous events and cursor after a later inventory page fails', async () => {
  await seed([event('saved')]);
  const before = structuredClone(cache.get(key));
  vi.mocked(exchangeCalendarApi.inventory).mockResolvedValueOnce({ events: [], versions: {} }).mockRejectedValueOnce(new Error('offline'));
  await expect(synchronizeEwsCalendar(cal, 'token', convert)).rejects.toThrow('offline');
  expect(cache.get(key)).toEqual(before);
});

it('restores the durable snapshot before a network failure even if the presentation cache was not written', async () => {
  await seed([event('saved')]);
  const progress = vi.fn();
  vi.mocked(exchangeCalendarApi.delta).mockRejectedValue(new Error('offline'));
  await expect(synchronizeEwsCalendar(cal, 'token', convert, [], progress)).rejects.toThrow('offline');
  expect(progress).toHaveBeenCalledWith([event('saved')]);
});

it('rebuilds the version inventory after an expired cursor without first clearing local data', async () => {
  await seed([event('saved')]);
  vi.mocked(exchangeCalendarApi.delta).mockResolvedValue({ syncState: 'reset-cursor', changed: true, reset: true });
  expect(await synchronizeEwsCalendar(cal, 'token', convert)).toEqual([]);
  expect(exchangeCalendarApi.inventory).toHaveBeenCalledTimes(9);
  expect(cache.get(key)).toMatchObject({ syncState: 'reset-cursor', events: [] });
});

it('coalesces concurrent readers of the same calendar', async () => {
  await seed([event('saved')]);
  let finish!: (value: unknown) => void;
  vi.mocked(exchangeCalendarApi.delta).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const first = synchronizeEwsCalendar(cal, 'token', convert);
  const second = synchronizeEwsCalendar(cal, 'token', convert);
  await vi.waitFor(() => expect(exchangeCalendarApi.delta).toHaveBeenCalledOnce());
  finish({ syncState: 'cursor2', changed: false, reset: false });
  expect(await first).toEqual(await second);
});
