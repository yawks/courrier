import { useQueries, useQueryClient } from '@tanstack/react-query';
import { CalendarConfig, CalendarEvent } from '../../../shared/types';
import { useExchangeAuth } from '../../../shared/store/ExchangeAuthStore';
import i18n from '../../../i18n';
import { useEffect, useMemo } from 'react';
import { exchangeCalendarApi } from '../../../shared/api/exchangeCalendarApi';
import { cacheGetStale, cacheSet } from '../utils/eventCache';
import { synchronizeEwsCalendar } from '../utils/ewsCalendarSync';
import { calendarSourceFingerprint, calendarSyncCacheKey } from '../utils/calendarSync';

export const CALENDAR_KEYS = {
  all: ['calendar'] as const,
  events: (calId: string) => [...CALENDAR_KEYS.all, calId, 'events'] as const,
};

// --- EWS FETCH ---
interface EwsEventRaw {
  uid?: string;
  availability_only?: boolean;
  sensitivity?: string;
  availability?: string;
  item_id: string;
  change_key: string;
  subject: string;
  start: string;
  end: string;
  is_all_day: boolean;
  location?: string;
  organizer_name?: string;
  organizer_email?: string;
  my_response_type: string;
  attendees: Array<{ name?: string; email: string; response_type: string; optional?: boolean; }>;
  is_meeting: boolean;
  is_cancelled: boolean;
  recurring_master_id?: string;
  body?: string;
}

function ewsResponseToRsvp(ewsStatus: string): any {
  switch (ewsStatus) {
    case 'Accept':
    case 'Organizer': return 'ACCEPTED';
    case 'Decline': return 'DECLINED';
    case 'Tentative': return 'TENTATIVE';
    default: return 'NEEDS-ACTION';
  }
}

function displayableEwsAddress(address?: string): string {
  const value = address?.trim() ?? '';
  return value.toUpperCase().startsWith('/O=') ? '' : value;
}

async function fetchEWSEvents(cal: CalendarConfig, accessToken: string): Promise<CalendarEvent[]> {
  const now = new Date();
  const start = new Date(now);
  // EWS CalendarView is capped at 500 occurrences and returns the oldest ones
  // first. A large range starting months ago can therefore contain no event for
  // the current view on busy calendars. Keep the window centred around today.
  start.setDate(start.getDate() - 4 * 7);
  const end = new Date(now);
  end.setDate(end.getDate() + 26 * 7);

  console.info('[Exchange calendar] Synchronisation démarrée', {
    calendarId: cal.id,
  });

  const raw = await exchangeCalendarApi.list<EwsEventRaw[]>({
      accessToken,
      ownerEmail: cal.ownerEmail,
      folderId: cal.exchangeFolderId,
      sharedMailbox: cal.shared?.ownerEmail,
      start: start.toISOString(),
      end: end.toISOString(),
  });

  const receivedDates = raw
    .map((event) => Date.parse(event.start))
    .filter(Number.isFinite);
  const firstDate = receivedDates.length > 0 ? new Date(Math.min(...receivedDates)).toISOString() : null;
  const lastDate = receivedDates.length > 0 ? new Date(Math.max(...receivedDates)).toISOString() : null;
  console.info(`[Exchange calendar] ${raw.length} événement(s) reçu(s)`, { firstDate, lastDate });

  return raw.map(ev => ewsEventToCalendarEvent(ev, cal));
}

export function ewsEventToCalendarEvent(ev: EwsEventRaw, cal: CalendarConfig): CalendarEvent {
    const isMeeting = ev.is_meeting || ev.attendees.length > 0;
    const attendees = ev.attendees.map((a) => ({
      name: a.name ?? a.email,
      email: a.email,
      status: ewsResponseToRsvp(a.response_type),
      isOrganizer: false,
      optional: a.optional ?? false,
    }));
    if (ev.organizer_email || ev.organizer_name) {
      const organizerEmail = displayableEwsAddress(ev.organizer_email);
      attendees.unshift({
        name: ev.organizer_name ?? organizerEmail,
        email: organizerEmail,
        status: 'ACCEPTED',
        isOrganizer: true,
        optional: false,
      });
    }
    const selfStatus = ewsResponseToRsvp(ev.my_response_type);
    return {
      id: `${cal.id}::${ev.item_id}`,
      icalUid: ev.uid,
      sourceId: ev.availability_only ? undefined : `${ev.item_id}|${ev.change_key}`,
      seriesId: ev.recurring_master_id ?? ev.item_id,
      isRecurringInstance: !!ev.recurring_master_id,
      calendarId: cal.id,
      title: ev.subject || (ev.availability_only ? i18n.t('sharedCalendars.busy') : ''),
      availabilityOnly: ev.availability_only,
      sensitivity: ev.sensitivity,
      availability: ev.availability,
      start: ev.start,
      end: ev.end,
      isAllday: ev.is_all_day,
      category: ev.is_all_day ? 'allday' : 'time',
      location: ev.location,
      description: ev.body || undefined,
      isDeclined: selfStatus === 'DECLINED',
      isCancelled: ev.is_cancelled,
      isUnaccepted: selfStatus !== 'ACCEPTED' && isMeeting,
      selfRsvpStatus: isMeeting ? selfStatus : undefined,
      attendees: isMeeting ? attendees : [],
    };
}

export async function fetchEWSItem(cal: CalendarConfig, accessToken: string, itemId: string, start: string, end: string, recurring: boolean): Promise<CalendarEvent[]> {
  const horizon = new Date();
  horizon.setDate(horizon.getDate() + 26 * 7);
  const raw = await exchangeCalendarApi.get<EwsEventRaw[]>({
    accessToken, itemId, ownerEmail: cal.ownerEmail, recurring,
    start: new Date(start).toISOString(), end: new Date(Math.max(horizon.getTime(), Date.parse(end))).toISOString(),
  });
  return raw.map(ev => ewsEventToCalendarEvent(ev, cal));
}

// --- MAIN HOOK ---
export function useCalendarEvents(calendars: CalendarConfig[], onLoaded?: (id: string, events: CalendarEvent[]) => void) {
  const { getValidToken: getEwsToken } = useExchangeAuth();
  const queryClient = useQueryClient();

  const results = useQueries({
    queries: calendars.map(cal => ({
      queryKey: CALENDAR_KEYS.events(cal.id),
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        if (cal.type === 'exchange') {
          const cacheKey = `ews-events:ews1:${cal.id}`;
          if (queryClient.getQueryData(CALENDAR_KEYS.events(cal.id)) === undefined) {
            let cached = await cacheGetStale<CalendarEvent[]>(cacheKey);
            if (!cached) {
              const durable = await cacheGetStale<{ source: string; events: CalendarEvent[] }>(calendarSyncCacheKey('exchange', cal.id));
              if (durable?.source === await calendarSourceFingerprint(cal) && Array.isArray(durable.events)) cached = durable.events;
            }
            if (signal.aborted) throw signal.reason;
            // Seed the query before fetching, so errors remain errors while
            // the last successful snapshot stays visible, even after GC/restart.
            if (cached && queryClient.getQueryData(CALENDAR_KEYS.events(cal.id)) === undefined) {
              queryClient.setQueryData(CALENDAR_KEYS.events(cal.id), cached, { updatedAt: 1 });
            }
          }
          const token = await getEwsToken(cal.exchangeAccountId!);
          if (!token) throw new Error('Unauthorized');
          let events: CalendarEvent[];
          try {
            events = await synchronizeEwsCalendar<EwsEventRaw>(cal, token, raw => ewsEventToCalendarEvent(raw, cal),
              queryClient.getQueryData<CalendarEvent[]>(CALENDAR_KEYS.events(cal.id)) ?? [],
              progress => {
                if (signal.aborted) return;
                queryClient.setQueryData(CALENDAR_KEYS.events(cal.id), progress);
                // Progressive data is useful after restart too, but has no
                // cursor until all history pages have completed successfully.
                void cacheSet(cacheKey, progress);
              });
          } catch (error) {
            // Availability-only shared calendars cannot expose folder cursors
            // or item versions. Preserve their existing, permission-checked view.
            if (!cal.shared || !/ErrorAccessDenied|ErrorItemNotFound|ErrorFolderNotFound/.test(String(error))) throw error;
            events = await fetchEWSEvents(cal, token);
          }
          if (signal.aborted) throw signal.reason;
          await cacheSet(cacheKey, events);
          return events;
        }
        return [];
      },
      enabled: cal.type === 'exchange',
      staleTime: 5 * 60 * 1000,
      retry: false, // Don't flood on Auth error
      retryOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    }))
  });

  const dataTimestamps = results.map(r => r.dataUpdatedAt).join(',');
  useEffect(() => {
    results.forEach((result, index) => {
      if (result.isSuccess && !result.isFetching) onLoaded?.(calendars[index].id, result.data);
    });
  // Results are tracked by their update timestamp, not their unstable wrapper.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataTimestamps, onLoaded]);
  // errorUpdatedAt remains unchanged when a later request succeeds. Include
  // status so an old failure cannot keep hiding a recovered Android snapshot.
  const errorTimestamps = results.map(r => `${r.errorUpdatedAt}:${r.status}`).join(',');
  // `isLoading` only covers the first load. Manual refreshes use `isFetching`,
  // which lets the header display progress every time the user clicks Refresh.
  const isLoading = results.some(r => r.isFetching);

  const allEvents = useMemo(() => {
    return results.flatMap(r => r.data ?? []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataTimestamps]);

  const errors = useMemo(() => {
    // Preserve result indexes so callers can associate an error with its calendar.
    return results.map(r => r.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errorTimestamps]);

  return useMemo(() => ({
    events: allEvents,
    isLoading,
    errors,
  }), [allEvents, isLoading, errors]);
}
