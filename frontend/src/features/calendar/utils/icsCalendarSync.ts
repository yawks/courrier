import type { CalendarConfig } from '../../../shared/types';
import { calendarApi } from '../../../shared/api/calendarApi';
import { cacheGetStale, cacheSet } from './eventCache';
import { calendarSourceFingerprint, calendarSyncCacheKey, coalesceCalendarSync } from './calendarSync';
import { parseICS } from './parseICS';

interface FeedSnapshot { source: string; text: string; etag?: string; lastModified?: string }

export async function synchronizeIcsCalendar(cal: CalendarConfig) {
  const source = await calendarSourceFingerprint(cal);
  const key = calendarSyncCacheKey('ics', cal.id);
  return coalesceCalendarSync(`${key}:${source}`, async () => {
    const cached = await cacheGetStale<FeedSnapshot>(key);
    const previous = cached?.source === source ? cached : null;
    const result = await calendarApi.fetchIcsResource(cal.url, previous?.etag, previous?.lastModified);
    const text = result.notModified ? previous?.text : result.text;
    if (!text || !/BEGIN:VCALENDAR/i.test(text) || !/END:VCALENDAR/i.test(text)) throw new Error('calendar_invalid_ics');
    // Re-expand locally on year changes even when the feed itself is unchanged.
    const events = parseICS(text, cal, true);
    await cacheSet(key, { source, text, etag: result.etag ?? (result.notModified ? previous?.etag : undefined),
      lastModified: result.lastModified ?? (result.notModified ? previous?.lastModified : undefined) } satisfies FeedSnapshot);
    return events;
  });
}
