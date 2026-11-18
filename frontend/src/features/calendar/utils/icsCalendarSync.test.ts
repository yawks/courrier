import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { synchronizeIcsCalendar } from './icsCalendarSync';
import { calendarApi } from '../../../shared/api/calendarApi';
import type { CalendarConfig } from '../../../shared/types';
import { parseICS } from './parseICS';

const cache = vi.hoisted(() => new Map<string, unknown>());
vi.mock('./eventCache', () => ({
  cacheGetStale: async (key: string) => structuredClone(cache.get(key) ?? null),
  cacheSet: async (key: string, value: unknown) => { cache.set(key, structuredClone(value)); },
}));
vi.mock('../../../shared/api/calendarApi', () => ({ calendarApi: { fetchIcsResource: vi.fn() } }));
const cal: CalendarConfig = { id: 'ics', name: 'Fixture', url: 'https://calendar.example/feed', color: '#123456', visible: true };
const feed = (start = '20221118T100000Z', end = '20221118T110000Z', rule = '') =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:fixture', 'SUMMARY:Appointment', `DTSTART:${start}`, `DTEND:${end}`, rule, 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
beforeEach(() => { cache.clear(); vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-18T12:00:00Z')); });
afterEach(() => vi.useRealTimers());

it('keeps multiple years and reuses the cached feed after a conditional 304', async () => {
  vi.mocked(calendarApi.fetchIcsResource).mockResolvedValueOnce({ text: feed(), etag: '"v1"', lastModified: 'yesterday' }).mockResolvedValueOnce({ notModified: true });
  expect(await synchronizeIcsCalendar(cal)).toHaveLength(1);
  expect(await synchronizeIcsCalendar(cal)).toHaveLength(1);
  expect(calendarApi.fetchIcsResource).toHaveBeenLastCalledWith(cal.url, '"v1"', 'yesterday');
});

it('does not replace a valid feed with a login page or a truncated file', async () => {
  vi.mocked(calendarApi.fetchIcsResource).mockResolvedValueOnce({ text: feed(), etag: '"v1"' });
  await synchronizeIcsCalendar(cal);
  const before = structuredClone([...cache]);
  vi.mocked(calendarApi.fetchIcsResource).mockResolvedValueOnce({ text: '<html>Login</html>' });
  await expect(synchronizeIcsCalendar(cal)).rejects.toThrow('calendar_invalid_ics');
  expect([...cache]).toEqual(before);
});

it('expands an old daily recurring master beyond the former 500-occurrence cutoff', () => {
  const events = parseICS(feed('20100101T100000Z', '20100101T110000Z', 'RRULE:FREQ=DAILY'), cal, true);
  expect(events.some(event => event.start.startsWith('2026-11-18'))).toBe(true);
  expect(events.some(event => event.start.startsWith('2029-12-31'))).toBe(true);
  expect(events.every(event => Date.parse(event.start) >= Date.parse('2021-01-01T00:00:00Z'))).toBe(true);
});
