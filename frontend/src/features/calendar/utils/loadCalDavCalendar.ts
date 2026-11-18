import { t } from 'i18next';
import { calendarApi } from '../../../shared/api/calendarApi';
import type { CalendarConfig, CalendarEvent } from '../../../shared/types';
import { davResponses, sameOriginDavUrl } from './sharedCalendars';
import { parseICS } from './parseICS';
import { parseCalDavTasks } from './parseCalDavTasks';
import { cacheGetStale, cacheSet } from './eventCache';
import { calendarSourceFingerprint, calendarSyncCacheKey, calendarSyncRange, coalesceCalendarSync, sameSyncRange, type CalendarSyncRange } from './calendarSync';

const DAV = 'DAV:';
const CALDAV = 'urn:ietf:params:xml:ns:caldav';
const NS = `xmlns:d="${DAV}" xmlns:c="${CALDAV}"`;
const PROPERTIES = '<d:resourcetype/><d:displayname/><d:current-user-principal/><c:calendar-home-set/><c:supported-calendar-component-set/><d:current-user-privilege-set/><d:sync-token/>';
const nodes = (element: Element, ns: string, name: string) => Array.from(element.getElementsByTagNameNS(ns, name));
const hrefs = (prop: Element, ns: string, name: string) => nodes(prop, ns, name).flatMap(set => nodes(set, DAV, 'href').map(href => href.textContent?.trim() ?? ''));

export interface CalDavSnapshot { events: CalendarEvent[]; readOnly: boolean }
interface DavResource { etag: string | null; ics: string }
interface DavCollection { token?: string; resources: Record<string, DavResource> }
interface DavSyncSnapshot { source: string; range: CalendarSyncRange; collections: Record<string, DavCollection> }
const escapeXml = (value: string) => value.replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!);

export async function loadCalDavCalendar(cal: CalendarConfig): Promise<CalDavSnapshot> {
  const source = await calendarSourceFingerprint(cal);
  const key = calendarSyncCacheKey('nextcloud', cal.id);
  return coalesceCalendarSync(`${key}:${source}`, () => loadCalDavCalendarSnapshot(cal, key, source));
}

async function loadCalDavCalendarSnapshot(cal: CalendarConfig, key: string, source: string): Promise<CalDavSnapshot> {
  const range = calendarSyncRange();
  const saved = await cacheGetStale<DavSyncSnapshot>(key);
  const previous = saved?.source === source && sameSyncRange(saved.range, range) ? saved : null;
  const collectionsState: Record<string, DavCollection> = {};
  const rawQuery = (url: string, method: 'PROPFIND' | 'REPORT', depth: '0' | '1', body: string) =>
    calendarApi.queryCalDav({ url: sameOriginDavUrl(cal.url, url), username: cal.nextcloudUsername ?? '', password: cal.nextcloudPassword ?? '' }, method, depth, body);
  const query = async (url: string, method: 'PROPFIND' | 'REPORT', depth: '0' | '1', body: string) => {
    const xml = await rawQuery(url, method, depth, body);
    if (method === 'REPORT') {
      const document = new DOMParser().parseFromString(xml, 'application/xml');
      const statuses = Array.from(document.getElementsByTagNameNS(DAV, 'status'));
      if (statuses.some(status => !/\s200\s/.test(status.textContent ?? ''))
        || document.getElementsByTagNameNS(DAV, 'number-of-matches-within-limits').length) {
        throw new Error('calendar_incomplete_dav_sync');
      }
    }
    return davResponses(xml);
  };
  const props = (url: string, depth: '0' | '1' = '0') => query(url, 'PROPFIND', depth, `<d:propfind ${NS}><d:prop>${PROPERTIES}</d:prop></d:propfind>`);
  const initial = await props(cal.url);
  const self = initial.find(({ href }) => sameOriginDavUrl(cal.url, href).replace(/\/$/, '') === cal.url.replace(/\/$/, ''));
  if (!self) throw new Error(t('config.caldavInvalidResponse'));
  const isCollection = nodes(self.prop, CALDAV, 'calendar').length > 0;
  let collections = isCollection ? [self] : [];
  if (!isCollection) {
    let homes = hrefs(self.prop, CALDAV, 'calendar-home-set');
    if (!homes.length) {
      const principal = hrefs(self.prop, DAV, 'current-user-principal')[0];
      if (principal) homes = (await props(principal)).flatMap(({ prop }) => hrefs(prop, CALDAV, 'calendar-home-set'));
    }
    // A calendar-home URL is also a valid entry point.
    if (!homes.length) homes = [cal.url];
    for (const home of [...new Set(homes)]) collections.push(...await props(home, '1'));
    collections = collections.filter(({ prop }) => nodes(prop, CALDAV, 'calendar').length > 0);
  }
  const unique = new Map(collections.map(collection => [sameOriginDavUrl(cal.url, collection.href), collection]));
  if (!unique.size) throw new Error(t('config.caldavNoCollections'));
  const events: CalendarEvent[] = [];
  let readOnly = !isCollection || !!cal.shared;
  for (const [url, { prop }] of unique) {
    const components = nodes(prop, CALDAV, 'comp').map(comp => comp.getAttribute('name'));
    const eventCollection = !components.length || components.includes('VEVENT');
    const taskCollection = components.includes('VTODO');
    const privileges = nodes(prop, DAV, 'current-user-privilege-set')[0];
    const writable = !privileges || ['write', 'write-content', 'all'].some(name => nodes(privileges, DAV, name).length > 0);
    if (!eventCollection || !writable) readOnly = true;
    const old = previous?.collections[url];
    let resources: Record<string, DavResource> = {};
    let syncToken = nodes(prop, DAV, 'sync-token')[0]?.textContent?.trim() || undefined;
    let usedDelta = false;
    if (old?.token && syncToken) {
      try {
        const xml = await rawQuery(url, 'REPORT', '1', `<d:sync-collection ${NS}><d:sync-token>${escapeXml(old.token)}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`);
        const document = new DOMParser().parseFromString(xml, 'application/xml');
        const root = document.documentElement;
        if (root.namespaceURI !== DAV || root.localName !== 'multistatus'
          || document.getElementsByTagName('parsererror').length) throw new Error('shared_invalid_dav_response');
        // Never commit a truncated sync response or any unexplained per-item error.
        if (document.getElementsByTagNameNS(DAV, 'number-of-matches-within-limits').length) throw new Error('calendar_incomplete_dav_sync');
        const token = Array.from(root.children).find(node => node.namespaceURI === DAV && node.localName === 'sync-token')?.textContent?.trim();
        if (!token) throw new Error('calendar_missing_dav_sync_token');
        resources = structuredClone(old.resources);
        const changed = new Map<string, string | null>();
        for (const response of Array.from(root.children).filter(node => node.namespaceURI === DAV && node.localName === 'response')) {
          const href = sameOriginDavUrl(url, nodes(response, DAV, 'href')[0]?.textContent?.trim() ?? '');
          const status = Array.from(response.children).find(node => node.localName === 'status' && node.namespaceURI === DAV)?.textContent ?? '';
          if (/\s(404|410)\s/.test(status)) { delete resources[href]; continue; }
          const propstats = nodes(response, DAV, 'propstat');
          if (!propstats.length || propstats.some(stat => !/\s200\s/.test(nodes(stat, DAV, 'status')[0]?.textContent ?? ''))) {
            throw new Error('calendar_incomplete_dav_sync');
          }
          const etag = nodes(response, DAV, 'getetag')[0]?.textContent?.trim() || null;
          if (!etag || resources[href]?.etag !== etag) changed.set(href, etag);
        }
        await fetchChangedDavResources(url, changed, resources, query);
        syncToken = token;
        usedDelta = true;
      } catch (error) {
        // Only invalid/unsupported tokens trigger a full ETag inventory.
        // Authentication, network, malformed and partial responses keep the cache.
        if (!/provider_http_(403|405|409|410|501)\b/.test(String(error))) throw error;
        syncToken = undefined;
      }
    }
    if (!usedDelta) {
      const changed = new Map<string, string | null>();
      for (const component of [eventCollection && 'VEVENT', taskCollection && 'VTODO'].filter((value): value is string => !!value)) {
        // Unexpanded resources are indexed once, including old recurring masters.
        // The display range is applied locally, not to the synchronization cursor.
        const responses = await query(url, 'REPORT', '1', `<c:calendar-query ${NS}><d:prop><d:getetag/>${old ? '' : '<c:calendar-data/>'}</d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="${component}"/></c:comp-filter></c:filter></c:calendar-query>`);
        for (const { href, prop: data } of responses) {
          const resourceUrl = sameOriginDavUrl(url, href);
          const etag = nodes(data, DAV, 'getetag')[0]?.textContent?.trim() || null;
          const ics = nodes(data, CALDAV, 'calendar-data')[0]?.textContent;
          if (ics) resources[resourceUrl] = { ics, etag };
          else if (etag && old?.resources[resourceUrl]?.etag === etag) resources[resourceUrl] = old.resources[resourceUrl];
          else changed.set(resourceUrl, etag);
        }
      }
      await fetchChangedDavResources(url, changed, resources, query);
    }
    collectionsState[url] = { token: syncToken, resources };
    const project = nodes(prop, DAV, 'displayname')[0]?.textContent?.trim() || undefined;
    for (const [resourceUrl, { ics, etag }] of Object.entries(resources)) {
      if (!/BEGIN:VCALENDAR/i.test(ics) || !/END:VCALENDAR/i.test(ics)) throw new Error('calendar_invalid_ics');
      const parsed = [
        ...(eventCollection ? parseICS(ics, cal, true) : []),
        ...(taskCollection ? parseCalDavTasks(ics, cal) : []),
      ];
      events.push(...parsed.map(event => ({ ...event,
          // Resource URLs distinguish identical UIDs in different project lists.
          id: isCollection ? event.id : `${event.id}:${resourceUrl}`,
          readOnly: event.isTask ? !!cal.shared || !writable || !etag || etag.startsWith('W/') : event.readOnly || readOnly,
          ...(event.caldavTask ? { caldavTask: { ...event.caldavTask, resourceUrl, etag, project } } : {}),
      })));
    }
  }
  await cacheSet(key, { source, range, collections: collectionsState } satisfies DavSyncSnapshot);
  return { events, readOnly };
}

async function fetchChangedDavResources(
  url: string, changed: Map<string, string | null>, resources: Record<string, DavResource>,
  query: (url: string, method: 'PROPFIND' | 'REPORT', depth: '0' | '1', body: string) => Promise<Array<{ href: string; prop: Element }>>,
) {
  const hrefs = [...changed.keys()];
  for (let offset = 0; offset < hrefs.length; offset += 100) {
    const batch = hrefs.slice(offset, offset + 100);
    const responses = await query(url, 'REPORT', '1', `<c:calendar-multiget ${NS}><d:prop><d:getetag/><c:calendar-data/></d:prop>${batch.map(href => `<d:href>${escapeXml(href)}</d:href>`).join('')}</c:calendar-multiget>`);
    const received = new Set<string>();
    for (const { href, prop } of responses) {
      const resourceUrl = sameOriginDavUrl(url, href);
      if (!changed.has(resourceUrl)) throw new Error('calendar_unexpected_dav_resource');
      const ics = nodes(prop, CALDAV, 'calendar-data')[0]?.textContent;
      if (!ics) throw new Error('calendar_missing_dav_resource');
      const etag = nodes(prop, DAV, 'getetag')[0]?.textContent?.trim() || null;
      resources[resourceUrl] = { ics, etag };
      received.add(resourceUrl);
    }
    if (batch.some(href => !received.has(href))) throw new Error('calendar_incomplete_dav_sync');
  }
}

export function calDavLoadError(error: unknown): string {
  const detail = error instanceof Error ? error.message : typeof error === 'string' ? error
    : error && typeof error === 'object' && 'detail' in error ? String(error.detail) : '';
  const status = detail.match(/provider_http_(\d{3})/i)?.[1];
  if (status) {
    const key = ({ '401': 'invalidCredentials', '403': 'accessForbidden', '404': 'urlNotFound' } as Record<string, string>)[status];
    return t(`config.${key ?? 'unexpectedResponse'}`, { status });
  }
  const messages = ['caldavInvalidResponse', 'caldavNoCollections'].map(key => t(`config.${key}`));
  return messages.includes(detail) ? detail : t('config.caldavLoadFailed');
}
