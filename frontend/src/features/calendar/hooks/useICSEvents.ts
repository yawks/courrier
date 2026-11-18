import { useState, useEffect, useCallback, useRef } from 'react';
import { CalendarConfig, CalendarEvent } from '../../../shared/types';
import { synchronizeIcsCalendar } from '../utils/icsCalendarSync';
import { cacheGetStale, cacheSet, cacheIsFresh } from '../utils/eventCache';

const CACHE_TTL = 30 * 60 * 1000; // 30 min
const CACHE_VERSION = 'v3';

function cacheKey(calId: string, ownerEmail?: string) {
  return `ics-events:${CACHE_VERSION}:${calId}:${ownerEmail ?? ''}`;
}

export function useICSEvents(calendars: CalendarConfig[], onLoaded?: (id: string, events: CalendarEvent[]) => void) {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const calendarsRef = useRef(calendars);
  calendarsRef.current = calendars;
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const run = useCallback(async (force: boolean) => {
    const toFetch = calendarsRef.current.filter((c) => c.url && (!c.type || c.type === 'ics'));
    if (!toFetch.length) {
      setEvents([]);
      setErrors({});
      return;
    }

    // Phase 1: show stale cache immediately (IDB read — very fast, no network)
    const stale = (await Promise.all(toFetch.map(async (cal) => {
      const cached = await cacheGetStale<CalendarEvent[]>(cacheKey(cal.id, cal.ownerEmail));
      if (cached) onLoadedRef.current?.(cal.id, cached);
      return cached;
    }))).flat().filter(Boolean) as CalendarEvent[];
    if (stale.length > 0) setEvents(current => [
      ...stale, ...current.filter(event => !stale.some(cached => cached.calendarId === event.calendarId)),
    ]);

    // Phase 2: determine which calendars need a network fetch
    const toRefresh = force
      ? toFetch
      : (await Promise.all(toFetch.map(async (cal) => ((await cacheIsFresh(cacheKey(cal.id, cal.ownerEmail), CACHE_TTL)) ? null : cal)))).filter(Boolean) as CalendarConfig[];

    if (!toRefresh.length) return;

    setLoading(true);
    const newErrors: Record<string, string> = {};

    const settled = await Promise.allSettled(
      toRefresh.map(async (cal) => {
        const parsed = await synchronizeIcsCalendar(cal);
        await cacheSet(cacheKey(cal.id, cal.ownerEmail), parsed);
        onLoadedRef.current?.(cal.id, parsed);
        return parsed;
      })
    );

    const results: CalendarEvent[] = [];
    const refreshedIds = new Set(toRefresh.map((c) => c.id));

    settled.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        results.push(...result.value);
      } else {
        newErrors[toRefresh[i].id] = result.reason?.message ?? 'Erreur inconnue';
        const previous = eventsRef.current.filter(event => event.calendarId === toRefresh[i].id);
        results.push(...(previous.length ? previous : stale.filter(event => event.calendarId === toRefresh[i].id)));
      }
    });

    for (const cal of toFetch) {
      if (!refreshedIds.has(cal.id)) {
        const cached = await cacheGetStale<CalendarEvent[]>(cacheKey(cal.id, cal.ownerEmail));
        if (cached) results.push(...cached);
      }
    }

    setEvents(results);
    setErrors(newErrors);
    setLoading(false);
  }, []);

  const calKey = calendars
    .filter((c) => c.url)
    .map((c) => `${c.id}:${c.url}:${c.ownerEmail ?? ''}`)
    .join(',');

  const prevKey = useRef('');
  useEffect(() => {
    if (calKey === prevKey.current) return;
    prevKey.current = calKey;
    run(false);
  }, [calKey, run]);

  const refresh = useCallback(() => run(true), [run]);

  return { events, loading, errors, refresh };
}
