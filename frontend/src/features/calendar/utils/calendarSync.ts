import type { CalendarConfig, CalendarEvent } from '../../../shared/types';

export interface CalendarSyncRange { start: string; end: string }

/** Stable for a calendar year: moving today's date must not invalidate cursors. */
export function calendarSyncRange(now = new Date()): CalendarSyncRange {
  return {
    start: new Date(Date.UTC(now.getFullYear() - 5, 0, 1)).toISOString(),
    end: new Date(Date.UTC(now.getFullYear() + 4, 0, 1)).toISOString(),
  };
}

export function inCalendarSyncRange(event: CalendarEvent, range: CalendarSyncRange): boolean {
  return Date.parse(event.start) < Date.parse(range.end) && Date.parse(event.end) > Date.parse(range.start);
}

export function sameSyncRange(left?: CalendarSyncRange, right?: CalendarSyncRange): boolean {
  return !!left && !!right && left.start === right.start && left.end === right.end;
}

/** No passwords, access tokens or private feed URLs are persisted in cursor metadata. */
export async function calendarSourceFingerprint(cal: CalendarConfig): Promise<string> {
  const source = JSON.stringify([cal.type, cal.url, cal.ownerEmail, cal.exchangeAccountId,
    cal.exchangeFolderId, cal.googleAccountId, cal.googleCalendarId, cal.nextcloudUsername, cal.shared]);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

const running = new Map<string, Promise<unknown>>();
export function coalesceCalendarSync<T>(key: string, work: () => Promise<T>): Promise<T> {
  const existing = running.get(key);
  if (existing) return existing as Promise<T>;
  const task = work();
  running.set(key, task);
  void task.finally(() => { if (running.get(key) === task) running.delete(key); }).catch(() => {});
  return task;
}

export const calendarSyncCacheKey = (provider: string, id: string) => `calendar-incremental:v1:${provider}:${id}`;
