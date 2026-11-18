import type { CalendarConfig, CalendarEvent } from '../../../shared/types';
import { cacheGetStale, cacheSet } from './eventCache';
import { calendarSourceFingerprint, calendarSyncCacheKey, calendarSyncRange, coalesceCalendarSync, inCalendarSyncRange, sameSyncRange, type CalendarSyncRange } from './calendarSync';
import { fetchGoogleCalendarChanges, fetchGoogleCalendarInstances, googleEventToCalendarEvent } from './googleCalendarApi';

interface GoogleSyncSnapshot {
  source: string;
  range: CalendarSyncRange;
  syncToken: string;
  groups: Record<string, { ids: string[]; recurring: boolean }>;
  events: CalendarEvent[];
}

export async function synchronizeGoogleCalendar(token: string, cal: CalendarConfig): Promise<CalendarEvent[]> {
  const source = await calendarSourceFingerprint(cal);
  const key = calendarSyncCacheKey('google', cal.id);
  return coalesceCalendarSync(`${key}:${source}`, async () => {
    const range = calendarSyncRange();
    const saved = await cacheGetStale<GoogleSyncSnapshot>(key);
    let previous = saved?.source === source && sameSyncRange(saved.range, range) ? saved : null;
    let changes;
    try {
      changes = await fetchGoogleCalendarChanges(token, cal, previous?.syncToken);
    } catch (error) {
      if (!previous || !/Google API 410\b/.test(String(error))) throw error;
      // Do not delete the old snapshot on token expiry: replace it only once
      // the complete new inventory and all changed series have been fetched.
      previous = null;
      changes = await fetchGoogleCalendarChanges(token, cal);
    }
    const events = new Map((previous?.events ?? []).map(event => [event.id, event]));
    const groups = structuredClone(previous?.groups ?? {}) as GoogleSyncSnapshot['groups'];
    const replace = (id: string, incoming: CalendarEvent[], recurring: boolean) => {
      for (const oldId of groups[id]?.ids ?? []) events.delete(oldId);
      const visible = incoming.filter(event => inCalendarSyncRange(event, range));
      for (const event of visible) events.set(event.id, event);
      groups[id] = { ids: visible.map(event => event.id), recurring };
    };
    const series = new Set<string>();
    const deletedMasters = new Set<string>();
    for (const item of changes.items) {
      if (item.recurringEventId) { series.add(item.recurringEventId); continue; }
      if (item.status === 'cancelled') {
        deletedMasters.add(item.id);
        replace(item.id, [], false);
        delete groups[item.id];
        // Sparse deletions can contain only an instance ID.
        events.delete(`${cal.id}-${item.id}`);
      } else if (item.recurrence?.length) {
        series.add(item.id);
      } else {
        const event = googleEventToCalendarEvent(item, cal, cal.ownerEmail);
        if (!event) throw new Error('Google calendar: invalid event snapshot');
        replace(item.id, [event], false);
      }
    }
    // Bound concurrency without serializing every calendar behind one account.
    const pending = [...series].filter(id => !deletedMasters.has(id));
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(2, pending.length) }, async () => {
      while (cursor < pending.length) {
        const id = pending[cursor++];
        replace(id, await fetchGoogleCalendarInstances(token, cal, id, range.start, range.end), true);
      }
    }));
    const snapshot: GoogleSyncSnapshot = { source, range, syncToken: changes.syncToken, groups, events: [...events.values()] };
    // Cursor and events share one IndexedDB record, never separate commits.
    await cacheSet(key, snapshot);
    return snapshot.events;
  });
}
