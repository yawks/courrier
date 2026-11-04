// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CalendarConfig } from '../../../shared/types';
import { calendarApi } from '../../../shared/api/calendarApi';
import { exchangeCalendarApi } from '../../../shared/api/exchangeCalendarApi';
import { listCalendars } from './googleCalendarApi';
import { discoverCalendarRooms, searchCalendarRoomDirectory } from './roomDiscovery';

vi.mock('../../../shared/api/calendarApi', () => ({ calendarApi: { queryCalDav: vi.fn() } }));
vi.mock('../../../shared/api/exchangeCalendarApi', () => ({ exchangeCalendarApi: { rooms: vi.fn() } }));
vi.mock('./googleCalendarApi', () => ({ listCalendars: vi.fn() }));

const base: CalendarConfig = { id: 'cal', name: 'Calendar', url: 'https://cloud.example.test/remote.php/dav/calendars/me/personal/', color: '', visible: true };
const dav = (content: string) => `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:s="http://sabredav.org/ns">${content}</d:multistatus>`;
const prop = (href: string, content: string) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${content}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('provider room discovery', () => {
  it('passes typed directory searches through EWS and keeps failures silent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cal = { ...base, type: 'exchange' as const, exchangeAccountId: 'exchange-account' };
    const auth = { getExchangeToken: vi.fn().mockResolvedValue('token') };
    vi.mocked(exchangeCalendarApi.rooms).mockResolvedValue([{ name: 'Room', email: 'room@example.test', directory: true }]);
    expect(await searchCalendarRoomDirectory(cal, '  Room  ', auth)).toEqual([{ id: 'room@example.test', name: 'Room', email: 'room@example.test', directory: true }]);
    expect(exchangeCalendarApi.rooms).toHaveBeenCalledWith({ accessToken: 'token', query: 'Room' });
    vi.mocked(exchangeCalendarApi.rooms).mockRejectedValueOnce(new Error('private diagnostics'));
    expect(await searchCalendarRoomDirectory(cal, 'Room', auth)).toEqual([]);
    expect(console.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private diagnostics');
  });
  it('uses the selected EWS account, deduplicates rooms and keeps failures optional', async () => {
    const getExchangeToken = vi.fn().mockResolvedValue('token');
    const cal = { ...base, type: 'exchange' as const, exchangeAccountId: 'exchange-account' };
    vi.mocked(exchangeCalendarApi.rooms).mockResolvedValue([{ name: 'Room', email: 'room@example.test' }, { name: 'Room', email: 'ROOM@example.test' }]);
    expect(await discoverCalendarRooms(cal, { getExchangeToken })).toHaveLength(1);
    expect(getExchangeToken).toHaveBeenCalledWith('exchange-account');
    expect(exchangeCalendarApi.rooms).toHaveBeenCalledWith({ accessToken: 'token' });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(exchangeCalendarApi.rooms).mockRejectedValue(new Error('raw response with secret'));
    expect(await discoverCalendarRooms(cal, { getExchangeToken })).toEqual([]);
    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.stringify(warning.mock.calls)).not.toContain('secret');
  });

  it('paginates the Google resource directory and excludes non-room resources', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ resourceId: '1', resourceName: 'Room A', resourceEmail: 'a@example.test', resourceCategory: 'CONFERENCE_ROOM' }], nextPageToken: 'page-2' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ resourceId: '2', resourceName: 'Car', resourceEmail: 'car@example.test', resourceCategory: 'OTHER' }, { resourceId: '3', resourceName: 'Room B', resourceEmail: 'b@example.test' }] })));
    vi.stubGlobal('fetch', fetcher);
    const rooms = await discoverCalendarRooms({ ...base, type: 'google', googleAccountId: 'google-account' }, { getValidToken: vi.fn().mockResolvedValue('token') });
    expect(rooms.map(room => room.name)).toEqual(['Room A', 'Room B']);
    expect(fetcher.mock.calls[1][0]).toContain('pageToken=page-2');
    expect(listCalendars).not.toHaveBeenCalled();
  });

  it('falls back to subscribed Google resources when directory access is denied', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })));
    vi.mocked(listCalendars).mockResolvedValue([
      { id: 'room@resource.calendar.google.com', summary: 'Known room', accessRole: 'freeBusyReader' },
      { id: 'person@example.test', summary: 'Person', accessRole: 'reader' },
    ]);
    expect(await discoverCalendarRooms({ ...base, type: 'google', googleAccountId: 'google' }, { getValidToken: vi.fn().mockResolvedValue('token') }))
      .toEqual([{ id: 'room@resource.calendar.google.com', email: 'room@resource.calendar.google.com', name: 'Known room' }]);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('discovers advertised Nextcloud resources without suggesting people, preserving partial results', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(calendarApi.queryCalDav)
      .mockResolvedValueOnce(dav(prop(base.url, '<d:principal-collection-set><d:href>/remote.php/dav/principals/users/</d:href><d:href>/remote.php/dav/principals/calendar-rooms/</d:href><d:href>/remote.php/dav/principals/calendar-resources/</d:href></d:principal-collection-set>')))
      .mockResolvedValueOnce(dav(prop('/remote.php/dav/principals/calendar-rooms/1/', '<d:displayname>Room &amp; board</d:displayname><c:calendar-user-type>ROOM</c:calendar-user-type><s:email-address>room@example.test</s:email-address>') + prop('/person', '<d:displayname>Person</d:displayname><c:calendar-user-type>INDIVIDUAL</c:calendar-user-type>')))
      .mockRejectedValueOnce(new Error('forbidden'));
    const rooms = await discoverCalendarRooms({ ...base, type: 'nextcloud', nextcloudUsername: 'me', nextcloudPassword: 'secret' }, {});
    expect(rooms).toEqual([{ id: 'https://cloud.example.test/remote.php/dav/principals/calendar-rooms/1/', name: 'Room & board', email: 'room@example.test' }]);
    expect(calendarApi.queryCalDav).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('secret');
  });

  it('never sends CalDAV credentials to a cross-origin principal collection', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(calendarApi.queryCalDav).mockResolvedValue(dav(prop(base.url, '<d:principal-collection-set><d:href>https://other.example.test/principals/</d:href></d:principal-collection-set>')));
    expect(await discoverCalendarRooms({ ...base, type: 'nextcloud', nextcloudPassword: 'secret' }, {})).toEqual([]);
    expect(calendarApi.queryCalDav).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('silently returns no suggestions for absent directories and read-only ICS providers', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(calendarApi.queryCalDav).mockResolvedValue(dav(prop(base.url, '<d:displayname>Calendar</d:displayname>')));
    expect(await discoverCalendarRooms({ ...base, type: 'nextcloud' }, {})).toEqual([]);
    expect(console.warn).toHaveBeenCalledOnce();
    vi.mocked(console.warn).mockClear();
    expect(await discoverCalendarRooms({ ...base, type: 'ics' }, {})).toEqual([]);
    expect(console.warn).not.toHaveBeenCalled();
  });
});
