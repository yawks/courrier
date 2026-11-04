/**
 * IndexedDB-based event cache — no size limit unlike localStorage.
 * Falls back silently on error (e.g. private browsing restrictions).
 */

const DB_NAME = 'calendar-event-cache';
const DB_VERSION = 1;
const STORE = 'entries';

type CacheEntry<T> = { value: T; at: number };

let _db: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      (e.target as IDBOpenDBRequest).result.createObjectStore(STORE);
    };
    req.onsuccess = (e) => {
      _db = (e.target as IDBOpenDBRequest).result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function cacheGet<T>(key: string, ttl: number): Promise<{ value: T; stale: boolean } | null> {
  try {
    const db = await openDB();
    const entry = await new Promise<CacheEntry<T> | undefined>((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    });
    if (!entry) return null;
    return { value: entry.value, stale: Date.now() - entry.at > ttl };
  } catch {
    return null;
  }
}

export async function cacheGetStale<T>(key: string): Promise<T | null> {
  try {
    const db = await openDB();
    const entry = await new Promise<CacheEntry<T> | undefined>((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    });
    return entry?.value ?? null;
  } catch {
    return null;
  }
}

export async function cacheSet<T>(key: string, value: T, preserveAge = false): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      if (preserveAge) {
        // A partial refresh must not make unrelated, older entries look fresh.
        const request = store.get(key);
        request.onsuccess = () => store.put({ value, at: request.result?.at ?? 0 } satisfies CacheEntry<T>, key);
      } else {
        store.put({ value, at: Date.now() } satisfies CacheEntry<T>, key);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // fail silently
  }
}

/**
 * Patch a single event's RSVP-related fields in a cached CalendarEvent array.
 * Preserves the existing cache timestamp so the TTL is unchanged.
 */
export async function patchCachedEventRsvp(
  key: string,
  eventId: string,
  status: import('../../../shared/types').AttendeeStatus,
): Promise<void> {
  try {
    const db = await openDB();
    type Events = import('../../../shared/types').CalendarEvent[];
    type Value = Events | { events: Events; readOnly: boolean };
    const entry = await new Promise<CacheEntry<Value> | undefined>((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as CacheEntry<Value> | undefined);
      req.onerror = () => resolve(undefined);
    });
    if (!entry) return;

    const events = Array.isArray(entry.value) ? entry.value : entry.value.events;
    const patched = events.map((ev) => {
      if (ev.id !== eventId) return ev;
      return {
        ...ev,
        selfRsvpStatus: status,
        isDeclined: status === 'DECLINED',
        isUnaccepted: status !== 'ACCEPTED',
      };
    });

    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      const value = Array.isArray(entry.value) ? patched : { ...entry.value, events: patched };
      tx.objectStore(STORE).put({ value, at: entry.at } satisfies CacheEntry<Value>, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // fail silently
  }
}

export async function cacheIsFresh(key: string, ttl: number): Promise<boolean> {
  try {
    const db = await openDB();
    const entry = await new Promise<CacheEntry<unknown> | undefined>((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    });
    if (!entry) return false;
    return Date.now() - entry.at <= ttl;
  } catch {
    return false;
  }
}

/** Replace only the saved event/series, leaving unrelated cached events intact. */
export function mergeCreatedEvents(events: import('../../../shared/types').CalendarEvent[], incoming: import('../../../shared/types').CalendarEvent[], calendarId: string, sourceId: string) {
  const ids = new Set(incoming.map(event => event.id));
  return [...events.filter(event => event.calendarId !== calendarId ||
    (!ids.has(event.id) && event.sourceId?.split('|')[0] !== sourceId && event.seriesId !== sourceId && event.icalUid !== sourceId)), ...incoming];
}
