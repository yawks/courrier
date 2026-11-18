import { expect, it } from 'vitest';
import { calendarSourceFingerprint, calendarSyncRange, inCalendarSyncRange } from './calendarSync';
import type { CalendarConfig, CalendarEvent } from '../../../shared/types';

it('retains five full past years, this year and three full future years with stable boundaries', () => {
  expect(calendarSyncRange(new Date('2026-01-01T12:00:00Z'))).toEqual({
    start: '2021-01-01T00:00:00.000Z', end: '2030-01-01T00:00:00.000Z',
  });
  expect(calendarSyncRange(new Date('2026-11-18T12:00:00Z'))).toEqual(calendarSyncRange(new Date('2026-01-01T12:00:00Z')));
});

it('keeps events overlapping the beginning of the range and excludes the exclusive end', () => {
  const range = calendarSyncRange(new Date('2026-11-18T12:00:00Z'));
  const event = { start: '2020-12-31T23:00:00Z', end: '2021-01-01T01:00:00Z' } as CalendarEvent;
  expect(inCalendarSyncRange(event, range)).toBe(true);
  expect(inCalendarSyncRange({ ...event, start: range.end, end: '2030-01-01T01:00:00Z' }, range)).toBe(false);
});

it('keys cursors by source identity, not by access-token renewal or calendar appearance', async () => {
  const cal: CalendarConfig = { id: 'calendar', name: 'Fixture', url: '', type: 'google', googleCalendarId: 'primary', googleAccountId: 'account', color: '#123456', visible: true };
  expect(await calendarSourceFingerprint(cal)).toBe(await calendarSourceFingerprint({ ...cal, name: 'Renamed', color: '#abcdef', visible: false }));
  expect(await calendarSourceFingerprint(cal)).not.toBe(await calendarSourceFingerprint({ ...cal, googleAccountId: 'other-account' }));
});
