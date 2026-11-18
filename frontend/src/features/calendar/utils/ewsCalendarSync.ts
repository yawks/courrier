import type { CalendarConfig, CalendarEvent } from '../../../shared/types';
import { exchangeCalendarApi } from '../../../shared/api/exchangeCalendarApi';
import { cacheGetStale, cacheSet } from './eventCache';
import { calendarSourceFingerprint, calendarSyncCacheKey, calendarSyncRange, coalesceCalendarSync, inCalendarSyncRange, sameSyncRange, type CalendarSyncRange } from './calendarSync';

interface EwsSyncSnapshot {
  source: string;
  range: CalendarSyncRange;
  syncState?: string;
  versions: Record<string, string>;
  events: CalendarEvent[];
}

export async function synchronizeEwsCalendar<Raw>(
  cal: CalendarConfig, accessToken: string, convert: (raw: Raw) => CalendarEvent,
  display: CalendarEvent[] = [], onProgress?: (events: CalendarEvent[]) => void,
): Promise<CalendarEvent[]> {
  const source = await calendarSourceFingerprint(cal);
  const key = calendarSyncCacheKey('exchange', cal.id);
  return coalesceCalendarSync(`${key}:${source}`, async () => {
    const range = calendarSyncRange();
    const saved = await cacheGetStale<EwsSyncSnapshot>(key);
    if (saved?.source === source && display.length === 0) onProgress?.(saved.events);
    const previous = saved?.source === source && sameSyncRange(saved.range, range) ? saved : null;
    const credentials = { accessToken, ownerEmail: cal.ownerEmail, folderId: cal.exchangeFolderId, sharedMailbox: cal.shared?.ownerEmail };
    const delta = await exchangeCalendarApi.delta<{ syncState?: string | null; changed: boolean; reset: boolean }>({
      ...credentials, syncState: previous?.syncState,
    });
    if (previous && !delta.changed && !delta.reset) {
      const snapshot = { ...previous, syncState: delta.syncState ?? undefined };
      await cacheSet(key, snapshot);
      return snapshot.events;
    }
    const events = new Map((previous?.events ?? []).map(event => [event.id, event]));
    const versions: Record<string, string> = {};
    // First history load is progressive, starting with the current month. Subsequent
    // changes need only a lightweight version inventory and changed GetItems.
    const windows: CalendarSyncRange[] = [];
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    for (let year = new Date(range.start).getUTCFullYear(); year < new Date(range.end).getUTCFullYear(); year++) {
      if (!previous && year === currentYear) {
        for (let month = 0; month < 12; month++) {
          windows.push({ start: new Date(Date.UTC(year, month, 1)).toISOString(), end: new Date(Date.UTC(year, month + 1, 1)).toISOString() });
        }
      } else {
        windows.push({ start: new Date(Date.UTC(year, 0, 1)).toISOString(), end: new Date(Date.UTC(year + 1, 0, 1)).toISOString() });
      }
    }
    const priority = (window: CalendarSyncRange) => {
      const date = new Date(window.start);
      return Math.abs(date.getUTCFullYear() - currentYear) * 100 + Math.abs(date.getUTCMonth() - now.getUTCMonth());
    };
    windows.sort((a, b) => priority(a) - priority(b));
    let visible = display;
    for (const window of windows) {
      const knownVersions: Record<string, string> = {};
      for (const event of previous?.events ?? []) {
        const id = event.sourceId?.split('|')[0];
        if (id && inCalendarSyncRange(event, window) && previous?.versions[id]) knownVersions[id] = previous.versions[id];
      }
      const page = await exchangeCalendarApi.inventory<{ events: Raw[]; versions: Record<string, string> }>({
        ...credentials, ...window, knownVersions,
      });
      if (!page || !Array.isArray(page.events) || !page.versions || typeof page.versions !== 'object') throw new Error('EWS calendar: invalid inventory');
      Object.assign(versions, page.versions);
      for (const raw of page.events) {
        const event = convert(raw);
        events.set(event.id, event);
      }
      if (!previous) {
        // Retain not-yet-fetched periods if a later history page fails.
        const fresh = page.events.map(convert);
        visible = [...visible.filter(event => Date.parse(event.start) >= Date.parse(window.end) || Date.parse(event.end) <= Date.parse(window.start)),
          ...fresh];
        visible = [...new Map(visible.map(event => [event.id, event])).values()];
        onProgress?.(visible);
      }
    }
    const current = [...events.values()].filter(event => !!event.sourceId && Object.hasOwn(versions, event.sourceId.split('|')[0])
      && inCalendarSyncRange(event, range));
    const snapshot: EwsSyncSnapshot = { source, range, syncState: delta.syncState ?? undefined, versions, events: current };
    await cacheSet(key, snapshot);
    return current;
  });
}
