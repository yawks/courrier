// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { getCreatedGoogleEvent } from './googleCalendarApi';
import { getCreatedNextcloudEvent } from './nextcloudCalendarApi';
import { mergeCreatedEvents } from './eventCache';
import { calendarApi } from '../../../shared/api/calendarApi';
import type { CalendarConfig, CalendarEvent } from '../../../shared/types';

vi.mock('../../../shared/api/calendarApi', () => ({ calendarApi: { fetchCalDav: vi.fn() } }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });
const cal = { id: 'cal', name: 'Calendar', url: 'https://calendar.example.test/events/', googleCalendarId: 'me@example.test', ownerEmail: 'me@example.test' } as CalendarConfig;
const google = { id: 'saved', summary: 'Planning', start: { dateTime: '2026-11-10T10:00:00Z' }, end: { dateTime: '2026-11-10T11:00:00Z' }, organizer: { email: 'me@example.test' }, attendees: [{ email: 'guest@example.test', optional: true, responseStatus: 'needsAction' }], conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.example.test/fixture' }] } };

it('reads only the saved Google item, retaining meeting details and organizer permissions', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(google)));
  vi.stubGlobal('fetch', fetch);
  const [event] = await getCreatedGoogleEvent('token', cal, 'saved');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe('https://www.googleapis.com/calendar/v3/calendars/me%40example.test/events/saved');
  expect(event.meetUrl).toBe('https://meet.example.test/fixture');
  expect(event.attendees).toContainEqual(expect.objectContaining({ email: 'me@example.test', isOrganizer: true }));
  expect(event.attendees).toContainEqual(expect.objectContaining({ email: 'guest@example.test', optional: true }));
});

it('reads only a Google series and pages through its instances', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...google, recurrence: ['RRULE:FREQ=WEEKLY'] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ ...google, id: 'saved_1', recurringEventId: 'saved' }], nextPageToken: 'next' })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ ...google, id: 'saved_2', recurringEventId: 'saved' }] })));
  vi.stubGlobal('fetch', fetch);
  const events = await getCreatedGoogleEvent('token', cal, 'saved');
  expect(events).toHaveLength(2);
  expect(events.every(event => event.seriesId === 'saved' && event.isRecurringInstance)).toBe(true);
  expect(fetch.mock.calls.slice(1).every(([url]) => String(url).includes('/events/saved/instances?'))).toBe(true);
  expect(fetch.mock.calls[2][0]).toContain('pageToken=next');
});

it('fetches the one CalDAV resource and expands its recurrence locally', async () => {
  vi.mocked(calendarApi.fetchCalDav).mockResolvedValue('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:saved\r\nSUMMARY:Planning\r\nDTSTART:20261110T100000Z\r\nDTEND:20261110T110000Z\r\nRRULE:FREQ=WEEKLY;COUNT=2\r\nEND:VEVENT\r\nEND:VCALENDAR');
  const events = await getCreatedNextcloudEvent(cal, 'saved');
  expect(calendarApi.fetchCalDav).toHaveBeenCalledTimes(1);
  expect(calendarApi.fetchCalDav).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://calendar.example.test/events/saved.ics' }));
  expect(events).toHaveLength(2);
  expect(events.every(event => event.sourceId === 'saved' && !event.readOnly)).toBe(true);
});

it('keeps read failures visible instead of interpreting them as empty successful reads', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Denied', { status: 403 })));
  await expect(getCreatedGoogleEvent('token', cal, 'saved')).rejects.toThrow('403');
  vi.mocked(calendarApi.fetchCalDav).mockResolvedValue('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR');
  await expect(getCreatedNextcloudEvent(cal, 'saved')).rejects.toThrow('not found');
});

it('merges by identity while preserving unrelated events with identical titles and times', () => {
  const old = { id: 'old', calendarId: 'cal', sourceId: 'saved|old-key', title: 'Planning' } as CalendarEvent;
  const other = { ...old, id: 'other', sourceId: 'unrelated|key' };
  const saved = { ...old, id: 'cal::saved', sourceId: 'saved|new-key' };
  expect(mergeCreatedEvents([old, other], [saved], 'cal', 'saved')).toEqual([other, saved]);
});
