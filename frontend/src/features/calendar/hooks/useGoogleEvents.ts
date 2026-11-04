import { AttendeeStatus, CalendarConfig, CalendarEvent } from '../../../shared/types';
import { cacheGetStale, cacheIsFresh, cacheSet, patchCachedEventRsvp, mergeCreatedEvents } from '../utils/eventCache';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getCreatedGoogleEvent, listEvents } from '../utils/googleCalendarApi';
import { useGoogleAuth } from '../../../shared/store/GoogleAuthStore';

const CACHE_TTL = 30 * 60 * 1000; // 30 min
const CACHE_VERSION = 'g1';

function cacheKey(calId: string) {
  return `google-events:${CACHE_VERSION}:${calId}`;
}

// Date window: 52 weeks past, 104 weeks future
function getDateRange() {
  const now = new Date();
  const timeMin = new Date(now);
  timeMin.setDate(timeMin.getDate() - 52 * 7);
  const timeMax = new Date(now);
  timeMax.setDate(timeMax.getDate() + 104 * 7);
  return { timeMin, timeMax };
}

export function useGoogleEvents(calendars: CalendarConfig[], onLoaded?: (id: string, events: CalendarEvent[]) => void) {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { getValidToken } = useGoogleAuth();
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const creationVersions = useRef(new Map<string, number>());
  const calendarsRef = useRef(calendars);
  calendarsRef.current = calendars;
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const run = useCallback(async (force: boolean, calendarId?: string) => {
    const googleCals = calendarsRef.current.filter((c) =>
      c.type === 'google' && c.googleCalendarId && c.googleAccountId
    );
    if (!googleCals.length) {
      setEvents([]);
      setErrors({});
      return;
    }

    const versions = new Map(creationVersions.current);
    // Phase 1: show stale cache immediately (IDB read — very fast, no network)
    const stale = (await Promise.all(googleCals.map(async (cal) => {
      const cached = await cacheGetStale<CalendarEvent[]>(cacheKey(cal.id));
      if (cached && creationVersions.current.get(cal.id) === versions.get(cal.id)) onLoadedRef.current?.(cal.id, cached);
      return cached;
    }))).flat().filter(Boolean) as CalendarEvent[];
    if (stale.length > 0) setEvents(current => [
      ...stale.filter(event => creationVersions.current.get(event.calendarId) === versions.get(event.calendarId)),
      ...current.filter(event => creationVersions.current.get(event.calendarId) !== versions.get(event.calendarId)),
    ]);

    // Phase 2: refresh expired / forced caches
    const toRefresh = force
      ? googleCals.filter((cal) => !calendarId || cal.id === calendarId)
      : (await Promise.all(googleCals.map(async (cal) => ((await cacheIsFresh(cacheKey(cal.id), CACHE_TTL)) ? null : cal)))).filter(Boolean) as CalendarConfig[];

    if (!toRefresh.length) return;

    setLoading(true);
    const newErrors: Record<string, string> = {};
    const { timeMin, timeMax } = getDateRange();

    const settled = await Promise.allSettled(
      toRefresh.map(async (cal) => {
        const token = await getValidToken(cal.googleAccountId!);
        if (!token) throw new Error('Token invalide ou expiré. Reconnectez votre compte Google.');
        const fetched = await listEvents(token, cal, timeMin, timeMax);
        if (creationVersions.current.get(cal.id) !== versions.get(cal.id)) return eventsRef.current.filter(event => event.calendarId === cal.id);
        await cacheSet(cacheKey(cal.id), fetched);
        if (creationVersions.current.get(cal.id) === versions.get(cal.id)) onLoadedRef.current?.(cal.id, fetched);
        return fetched;
      })
    );

    const results: CalendarEvent[] = [];
    const refreshedIds = new Set(toRefresh.map((c) => c.id));

    settled.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        results.push(...result.value);
      } else {
        newErrors[toRefresh[i].id] = result.reason?.message ?? 'Erreur inconnue';
      }
    });

    for (const cal of googleCals) {
      if (!refreshedIds.has(cal.id)) {
        const cached = await cacheGetStale<CalendarEvent[]>(cacheKey(cal.id));
        if (cached) results.push(...cached);
      }
    }

    setEvents(current => [
      ...results.filter(event => creationVersions.current.get(event.calendarId) === versions.get(event.calendarId)),
      ...current.filter(event => creationVersions.current.get(event.calendarId) !== versions.get(event.calendarId)),
    ]);
    setErrors(newErrors);
    setLoading(false);
    return results;
  }, [getValidToken]);

  const calKey = calendars
    .filter((c) => c.type === 'google')
    .map((c) => `${c.id}:${c.googleCalendarId}:${c.googleAccountId}`)
    .join(',');

  const prevKey = useRef('');
  useEffect(() => {
    if (calKey === prevKey.current) return;
    prevKey.current = calKey;
    run(false);
  }, [calKey, run]);

  const refresh = useCallback((calendarId?: string) => run(true, calendarId), [run]);

  const refreshCreated = useCallback(async (calendarId: string, sourceId: string) => {
    const cal = calendarsRef.current.find(cal => cal.id === calendarId);
    if (!cal) throw new Error('Calendar not found');
    const token = await getValidToken(cal.googleAccountId!);
    if (!token) throw new Error('Google calendar: missing access token');
    const incoming = await getCreatedGoogleEvent(token, cal, sourceId);
    creationVersions.current.set(calendarId, (creationVersions.current.get(calendarId) ?? 0) + 1);
    const merged = mergeCreatedEvents(eventsRef.current, incoming, calendarId, sourceId);
    eventsRef.current = merged;
    setEvents(merged);
    const updated = merged.filter(event => event.calendarId === calendarId);
    onLoadedRef.current?.(calendarId, updated);
    setErrors(current => { const next = { ...current }; delete next[calendarId]; return next; });
    await cacheSet(cacheKey(calendarId), updated, true);
    return incoming;
  }, [getValidToken]);

  return { events, loading, errors, refresh, refreshCreated };
}

/** Patch a single Google event's RSVP status in the IndexedDB cache. */
export function patchGoogleCachedRsvp(calId: string, eventId: string, status: AttendeeStatus): Promise<void> {
  return patchCachedEventRsvp(`google-events:${CACHE_VERSION}:${calId}`, eventId, status);
}
