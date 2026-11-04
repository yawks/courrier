import type { CalendarConfig } from '../../../shared/types';
import { exchangeCalendarApi } from '../../../shared/api/exchangeCalendarApi';
import { calendarApi } from '../../../shared/api/calendarApi';
import { listCalendars } from './googleCalendarApi';
import { davResponses, sameOriginDavUrl } from './sharedCalendars';

export interface CalendarRoom { name: string; email?: string; id: string; directory?: boolean }
export interface RoomDiscoveryAuth {
  getValidToken?: (accountId: string) => Promise<string | null>;
  getExchangeToken?: (accountId: string) => Promise<string | null>;
}

/** ResolveNames searches the directory, not a certified room inventory. */
export async function searchCalendarRoomDirectory(cal: CalendarConfig, query: string, auth: RoomDiscoveryAuth): Promise<CalendarRoom[]> {
  if (cal.type !== 'exchange' || query.trim().length < 2) return [];
  try {
    const token = cal.exchangeAccountId && await auth.getExchangeToken?.(cal.exchangeAccountId);
    if (!token) throw new Error('room_auth_unavailable');
    console.info('[Room discovery] exchange directory search started');
    const rooms = await exchangeCalendarApi.rooms({ accessToken: token, query: query.trim() });
    console.info('[Room discovery] exchange directory search completed', { count: rooms.length });
    return uniqueRooms(rooms.map(room => ({ ...room, id: room.email, directory: true })));
  } catch { warn('exchange', 'directory search'); return []; }
}

// Do not log upstream errors: they may contain credentials, URLs or account data.
function warn(provider: string, operation = 'discovery') {
  console.warn(`[Room discovery] ${provider} ${operation} unavailable; keeping free-text location.`);
}

function uniqueRooms(rooms: CalendarRoom[]): CalendarRoom[] {
  const unique = new Map<string, CalendarRoom>();
  for (const room of rooms) {
    if (room.name.trim()) unique.set((room.email || room.id).toLowerCase(), room);
  }
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function googleRooms(token: string): Promise<CalendarRoom[]> {
  try {
    const rooms: CalendarRoom[] = [];
    let pageToken = '';
    const visited = new Set<string>();
    do {
      if (visited.has(pageToken)) throw new Error('room_directory_pagination');
      visited.add(pageToken);
      const params = new URLSearchParams({ maxResults: '500', ...(pageToken ? { pageToken } : {}) });
      const response = await fetch(`https://admin.googleapis.com/admin/directory/v1/customer/my_customer/resources/calendars?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error('room_directory_unavailable');
      const data = await response.json() as { items?: Array<{ resourceId: string; resourceName?: string; generatedResourceName?: string; resourceEmail?: string; resourceCategory?: string }>; nextPageToken?: string };
      for (const room of data.items ?? []) {
        if (room.resourceCategory && room.resourceCategory !== 'CONFERENCE_ROOM') continue;
        const name = room.generatedResourceName || room.resourceName || room.resourceEmail;
        if (name && room.resourceEmail) rooms.push({ id: room.resourceId || room.resourceEmail, name, email: room.resourceEmail });
      }
      pageToken = data.nextPageToken ?? '';
    } while (pageToken);
    return rooms;
  } catch {
    warn('google', 'resource directory');
    // Calendar consent can expose subscribed resource calendars even when the
    // Workspace directory is forbidden. Ordinary shared calendars are not rooms.
    return (await listCalendars(token))
      .filter(calendar => /@resource\.calendar\.google\.com$/i.test(calendar.id))
      .map(calendar => ({ id: calendar.id, name: calendar.summary || calendar.id, email: calendar.id }));
  }
}

const DAV = 'DAV:';
const CALDAV = 'urn:ietf:params:xml:ns:caldav';
const SABRE = 'http://sabredav.org/ns';
const NS = `xmlns:d="${DAV}" xmlns:c="${CALDAV}" xmlns:s="${SABRE}"`;
const nodes = (element: Element, ns: string, name: string) => Array.from(element.getElementsByTagNameNS(ns, name));
const text = (element: Element, ns: string, name: string) => nodes(element, ns, name)[0]?.textContent?.trim() ?? '';

async function nextcloudRooms(cal: CalendarConfig): Promise<CalendarRoom[]> {
  const query = async (url: string, method: 'PROPFIND' | 'REPORT', body: string) => {
    const target = sameOriginDavUrl(cal.url, url);
    const xml = await calendarApi.queryCalDav({ url: target, username: cal.nextcloudUsername ?? '', password: cal.nextcloudPassword ?? '' }, method, '0', body);
    return { target, responses: davResponses(xml) };
  };
  const initial = await query(cal.url, 'PROPFIND', `<d:propfind ${NS}><d:prop><d:principal-collection-set/></d:prop></d:propfind>`);
  const collections = initial.responses.flatMap(({ prop }) => nodes(prop, DAV, 'principal-collection-set')
    .flatMap(set => nodes(set, DAV, 'href').map(href => sameOriginDavUrl(initial.target, href.textContent ?? ''))));
  if (!collections.length) throw new Error('room_directory_unavailable');
  // Nextcloud advertises dedicated collections; other CalDAV servers may expose
  // mixed collections. In both cases, only ROOM/RESOURCE principals qualify.
  const dedicated = collections.filter(url => /calendar-(rooms|resources)\/?$/.test(new URL(url).pathname));
  const rooms: CalendarRoom[] = [];
  for (const collection of new Set(dedicated.length ? dedicated : collections)) {
    try {
      const body = `<d:principal-property-search ${NS}><d:property-search><d:prop><d:displayname/></d:prop><d:match></d:match></d:property-search><d:prop><d:displayname/><s:email-address/><c:calendar-user-address-set/><c:calendar-user-type/></d:prop></d:principal-property-search>`;
      const { target, responses } = await query(collection, 'REPORT', body);
      for (const { href, prop } of responses) {
        if (!['ROOM', 'RESOURCE'].includes(text(prop, CALDAV, 'calendar-user-type').toUpperCase())) continue;
        const email = text(prop, SABRE, 'email-address') || nodes(prop, CALDAV, 'calendar-user-address-set')
          .flatMap(set => nodes(set, DAV, 'href').map(node => node.textContent ?? ''))
          .find(address => /^mailto:/i.test(address))?.replace(/^mailto:/i, '');
        const name = text(prop, DAV, 'displayname') || email;
        if (name) rooms.push({ id: sameOriginDavUrl(target, href), name, email });
      }
    } catch { warn('nextcloud', 'principal collection'); }
  }
  return rooms;
}

/** Optional discovery must never prevent writing or saving a location. */
export async function discoverCalendarRooms(cal: CalendarConfig, auth: RoomDiscoveryAuth): Promise<CalendarRoom[]> {
  const provider = cal.type ?? 'ics';
  if (!['exchange', 'google', 'nextcloud'].includes(provider)) return [];
  console.info(`[Room discovery] ${provider} started`);
  try {
    let rooms: CalendarRoom[];
    if (cal.type === 'exchange') {
      console.info('[Room discovery] exchange authentication', {
        hasAccount: Boolean(cal.exchangeAccountId), hasTokenGetter: Boolean(auth.getExchangeToken),
      });
      const token = cal.exchangeAccountId && await auth.getExchangeToken?.(cal.exchangeAccountId);
      if (!token) throw new Error('room_auth_unavailable');
      console.info('[Room discovery] exchange requesting rooms');
      rooms = (await exchangeCalendarApi.rooms({ accessToken: token })).map(room => ({ ...room, id: room.email }));
    } else if (cal.type === 'google') {
      const token = cal.googleAccountId && await auth.getValidToken?.(cal.googleAccountId);
      if (!token) throw new Error('room_auth_unavailable');
      rooms = await googleRooms(token);
    } else {
      rooms = await nextcloudRooms(cal);
    }
    const result = uniqueRooms(rooms);
    console.info(`[Room discovery] ${provider} completed`, { count: result.length });
    if (!result.length) console.warn(`[Room discovery] ${provider} returned no visible rooms or resources; keeping free-text location.`);
    return result;
  } catch { warn(provider); }
  return [];
}
