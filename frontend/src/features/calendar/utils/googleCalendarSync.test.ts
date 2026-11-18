import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { synchronizeGoogleCalendar } from './googleCalendarSync';
import { calendarSyncCacheKey } from './calendarSync';
import type { CalendarConfig } from '../../../shared/types';

const cache = vi.hoisted(() => new Map<string, unknown>());
vi.mock('./eventCache', () => ({
  cacheGetStale: async (key: string) => structuredClone(cache.get(key) ?? null),
  cacheSet: async (key: string, value: unknown) => { cache.set(key, structuredClone(value)); },
}));
const cal: CalendarConfig = { id: 'google', name: 'Fixture', url: '', type: 'google', color: '#123456', visible: true, googleAccountId: 'account', googleCalendarId: 'primary' };
const event = (id: string, extra = {}) => ({
  id, summary: id, start: { dateTime: '2026-11-18T10:00:00Z' }, end: { dateTime: '2026-11-18T11:00:00Z' }, ...extra,
});
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const request = vi.fn();
beforeEach(() => {
  cache.clear(); request.mockReset();
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-18T12:00:00Z'));
  vi.stubGlobal('fetch', request);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('loads all change pages and series once, then refreshes without fetching unchanged events', async () => {
  request.mockResolvedValueOnce(respond({ items: [event('old', { start: { date: '2022-01-01' }, end: { date: '2022-01-02' } })], nextPageToken: 'p2' }))
    .mockResolvedValueOnce(respond({ items: [event('series', { recurrence: ['RRULE:FREQ=WEEKLY'] })], nextSyncToken: 'v1' }))
    .mockResolvedValueOnce(respond({ items: [event('instance', { recurringEventId: 'series' })] }));
  expect(await synchronizeGoogleCalendar('token', cal)).toHaveLength(2);
  const first = new URL(request.mock.calls[0][0]);
  expect(first.searchParams.get('singleEvents')).toBe('false');
  expect(first.searchParams.has('timeMin')).toBe(false);
  expect(first.searchParams.has('orderBy')).toBe(false);
  request.mockResolvedValueOnce(respond({ items: [], nextSyncToken: 'v2' }));
  expect(await synchronizeGoogleCalendar('new-token', cal)).toHaveLength(2);
  expect(request).toHaveBeenCalledTimes(4);
  expect(new URL(request.mock.calls[3][0]).searchParams.get('syncToken')).toBe('v1');
});

it('applies sparse deletions and replaces every occurrence of a changed series', async () => {
  request.mockResolvedValueOnce(respond({ items: [event('single'), event('series', { recurrence: ['RRULE:FREQ=DAILY'] })], nextSyncToken: 'v1' }))
    .mockResolvedValueOnce(respond({ items: [event('old-instance', { recurringEventId: 'series' })] }));
  await synchronizeGoogleCalendar('token', cal);
  request.mockResolvedValueOnce(respond({ items: [{ id: 'single', status: 'cancelled' }, { id: 'old-instance', recurringEventId: 'series', status: 'cancelled' }], nextSyncToken: 'v2' }))
    .mockResolvedValueOnce(respond({ items: [event('new-instance', { recurringEventId: 'series' }), event('cancelled', { status: 'cancelled' })] }));
  expect((await synchronizeGoogleCalendar('token', cal)).map(event => event.sourceId)).toEqual(['new-instance']);
});

it('does not advance the cursor after a failed changed-series read', async () => {
  request.mockResolvedValueOnce(respond({ items: [event('single')], nextSyncToken: 'v1' }));
  await synchronizeGoogleCalendar('token', cal);
  const before = structuredClone(cache.get(calendarSyncCacheKey('google', cal.id)));
  request.mockResolvedValueOnce(respond({ items: [event('series', { recurrence: ['RRULE:FREQ=DAILY'] })], nextSyncToken: 'v2' }))
    .mockResolvedValueOnce(respond({ error: 'unavailable' }, 503));
  await expect(synchronizeGoogleCalendar('token', cal)).rejects.toThrow('Google API 503');
  expect(cache.get(calendarSyncCacheKey('google', cal.id))).toEqual(before);
});

it('rebuilds an expired token without dropping the previous snapshot on an incomplete rebuild', async () => {
  request.mockResolvedValueOnce(respond({ items: [event('single')], nextSyncToken: 'v1' }));
  await synchronizeGoogleCalendar('token', cal);
  const before = structuredClone(cache.get(calendarSyncCacheKey('google', cal.id)));
  request.mockResolvedValueOnce(respond({}, 410))
    .mockResolvedValueOnce(respond({ items: [], nextPageToken: 'next' }))
    .mockResolvedValueOnce(respond({}, 503));
  await expect(synchronizeGoogleCalendar('token', cal)).rejects.toThrow('Google API 503');
  expect(new URL(request.mock.calls[2][0]).searchParams.has('syncToken')).toBe(false);
  expect(cache.get(calendarSyncCacheKey('google', cal.id))).toEqual(before);
});

it('rejects a missing final cursor instead of committing a partial list', async () => {
  request.mockResolvedValueOnce(respond({ items: [event('single')] }));
  await expect(synchronizeGoogleCalendar('token', cal)).rejects.toThrow('missing synchronization token');
  expect(cache.size).toBe(0);
});

it('removes an event moved outside the retained years and never mixes different sources', async () => {
  request.mockResolvedValueOnce(respond({ items: [event('single')], nextSyncToken: 'v1' }));
  await synchronizeGoogleCalendar('token', cal);
  request.mockResolvedValueOnce(respond({ items: [event('single', { start: { date: '2040-01-01' }, end: { date: '2040-01-02' } })], nextSyncToken: 'v2' }));
  expect(await synchronizeGoogleCalendar('token', cal)).toEqual([]);
  request.mockResolvedValueOnce(respond({ items: [], nextSyncToken: 'other' }));
  await synchronizeGoogleCalendar('token', { ...cal, googleCalendarId: 'other' });
  expect(new URL(request.mock.calls[2][0]).searchParams.has('syncToken')).toBe(false);
});
