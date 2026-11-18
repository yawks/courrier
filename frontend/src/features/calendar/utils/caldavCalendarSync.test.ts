// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadCalDavCalendar } from './loadCalDavCalendar';
import { calendarApi } from '../../../shared/api/calendarApi';
import type { CalendarConfig } from '../../../shared/types';
import '../../../i18n';

const cache = vi.hoisted(() => new Map<string, unknown>());
vi.mock('./eventCache', () => ({
  cacheGetStale: async (key: string) => structuredClone(cache.get(key) ?? null),
  cacheSet: async (key: string, value: unknown) => { cache.set(key, structuredClone(value)); },
}));
vi.mock('../../../shared/api/calendarApi', () => ({ calendarApi: { queryCalDav: vi.fn() } }));
const cal: CalendarConfig = { id: 'dav', type: 'nextcloud', name: 'Fixture', url: 'https://cloud.example/cal/', nextcloudUsername: 'fixture', nextcloudPassword: 'secret', visible: true, color: '#123456' };
const xml = (body = '', token = '') => `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${body}${token ? `<d:sync-token>${token}</d:sync-token>` : ''}</d:multistatus>`;
const response = (href: string, properties: string) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${properties}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const collection = (token = '') => xml(response(cal.url, `<d:resourcetype><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>${token ? `<d:sync-token>${token}</d:sync-token>` : ''}`));
const feed = (title: string) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:fixture', `SUMMARY:${title}`, 'DTSTART:20221118T100000Z', 'DTEND:20221118T110000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
const resource = (title: string, etag: string, href = '/cal/event.ics') => response(href, `<d:getetag>"${etag}"</d:getetag><c:calendar-data>${feed(title)}</c:calendar-data>`);
const meta = (etag: string, href = '/cal/event.ics') => response(href, `<d:getetag>"${etag}"</d:getetag>`);
beforeEach(() => {
  cache.clear(); vi.resetAllMocks();
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-18T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());
async function initial(token = 'v1') {
  vi.mocked(calendarApi.queryCalDav).mockResolvedValueOnce(collection(token)).mockResolvedValueOnce(xml(resource('Initial', 'e1')));
  expect((await loadCalDavCalendar(cal)).events[0].title).toBe('Initial');
}

it('uses sync-collection after the initial resource snapshot, without re-downloading unchanged data', async () => {
  await initial();
  vi.mocked(calendarApi.queryCalDav).mockResolvedValueOnce(collection('v1')).mockResolvedValueOnce(xml('', 'v1'));
  expect((await loadCalDavCalendar(cal)).events[0].start).toContain('2022-');
  expect(calendarApi.queryCalDav).toHaveBeenCalledTimes(4);
  expect(vi.mocked(calendarApi.queryCalDav).mock.calls[3][3]).toContain('<d:sync-token>v1</d:sync-token>');
});

it('downloads only changed resources and applies remote deletions', async () => {
  await initial();
  vi.mocked(calendarApi.queryCalDav).mockResolvedValueOnce(collection('v2'))
    .mockResolvedValueOnce(xml(meta('e2'), 'v2'))
    .mockResolvedValueOnce(xml(resource('Updated', 'e2')));
  expect((await loadCalDavCalendar(cal)).events[0].title).toBe('Updated');
  expect(vi.mocked(calendarApi.queryCalDav).mock.calls[4][3]).toContain('calendar-multiget');
  vi.mocked(calendarApi.queryCalDav).mockResolvedValueOnce(collection('v3')).mockResolvedValueOnce(xml(
    '<d:response><d:href>/cal/event.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>', 'v3'));
  expect((await loadCalDavCalendar(cal)).events).toEqual([]);
});

it('uses ETag inventory comparisons when sync tokens are unavailable', async () => {
  await initial('');
  vi.mocked(calendarApi.queryCalDav).mockResolvedValueOnce(collection()).mockResolvedValueOnce(xml(meta('e1')));
  expect((await loadCalDavCalendar(cal)).events[0].title).toBe('Initial');
  expect(calendarApi.queryCalDav).toHaveBeenCalledTimes(4);
  expect(vi.mocked(calendarApi.queryCalDav).mock.calls[3][3]).not.toContain('calendar-data');
});

it('rebuilds the ETag inventory on token expiration without reloading unchanged resources', async () => {
  await initial();
  vi.mocked(calendarApi.queryCalDav).mockResolvedValueOnce(collection('v2'))
    .mockRejectedValueOnce(new Error('provider_http_409')).mockResolvedValueOnce(xml(meta('e1')));
  expect((await loadCalDavCalendar(cal)).events[0].title).toBe('Initial');
  expect(calendarApi.queryCalDav).toHaveBeenCalledTimes(5);
});

it.each(['offline', 'partial'])('does not commit a token or deletions after an incomplete %s response', async failure => {
  await initial();
  const before = structuredClone([...cache]);
  vi.mocked(calendarApi.queryCalDav).mockResolvedValueOnce(collection('v2'));
  if (failure === 'offline') vi.mocked(calendarApi.queryCalDav).mockRejectedValueOnce(new Error('offline'));
  else vi.mocked(calendarApi.queryCalDav).mockResolvedValueOnce(xml(meta('e2'), 'v2')).mockResolvedValueOnce(xml());
  await expect(loadCalDavCalendar(cal)).rejects.toThrow();
  expect([...cache]).toEqual(before);
});

it('rejects foreign-origin changed resources before sending credentials to them', async () => {
  await initial();
  vi.mocked(calendarApi.queryCalDav).mockResolvedValueOnce(collection('v2')).mockResolvedValueOnce(xml(meta('e2', 'https://attacker.example/event.ics'), 'v2'));
  await expect(loadCalDavCalendar(cal)).rejects.toThrow('shared_invalid_dav_url');
  expect(calendarApi.queryCalDav).toHaveBeenCalledTimes(4);
});

it('does not turn a forbidden ETag inventory member into a deletion', async () => {
  await initial('');
  const before = structuredClone([...cache]);
  vi.mocked(calendarApi.queryCalDav).mockResolvedValueOnce(collection()).mockResolvedValueOnce(xml(
    '<d:response><d:href>/cal/event.ics</d:href><d:status>HTTP/1.1 403 Forbidden</d:status></d:response>'));
  await expect(loadCalDavCalendar(cal)).rejects.toThrow('calendar_incomplete_dav_sync');
  expect([...cache]).toEqual(before);
});
