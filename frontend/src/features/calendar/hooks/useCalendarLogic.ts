import { mergeCreatedEvents } from '../utils/eventCache';
import { isEventOrganizer, isEventEditable as canEditEvent } from '../utils/eventPermissions';
import { useAndroidCalendars } from '../store/AndroidCalendarProvider';
import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { CalendarConfig, CalendarEvent, CreateEventPayload, ViewType } from '../../../shared/types';
import { useCalendars } from '../store/CalendarStore';
import { useCalendarGroups } from '../store/CalendarGroupStore';
import { useEWSEvents } from './useEWSEvents';
import { useGoogleEvents } from './useGoogleEvents';
import { useICSEvents } from './useICSEvents';
import { useNextcloudEvents } from './useNextcloudEvents';
import { useTags } from '../store/TagStore';
import { useTheme } from '../../../shared/store/ThemeStore';
import { useExchangeAuth } from '../../../shared/store/ExchangeAuthStore';
import { useGoogleAuth } from '../../../shared/store/GoogleAuthStore';
import { DEMO_CALENDARS, DEMO_EVENTS } from '../../../demo/demoData';
import i18n from '../../../i18n';
import { getGoogleRecurrence, createEvent, updateEvent, deleteGoogleEvent, respondToGoogleEvent } from '../utils/googleCalendarApi';
import { getNextcloudRecurrence, createNextcloudEvent, updateNextcloudEvent, deleteNextcloudEvent, cancelNextcloudEvent, respondToNextcloudEvent } from '../utils/nextcloudCalendarApi';
import { useQueryClient } from '@tanstack/react-query';
import { CALENDAR_KEYS, fetchEWSItem } from './useCalendarQueries';
import { exchangeCalendarApi } from '../../../shared/api/exchangeCalendarApi';
import { isOfflineLikeError } from '../../../shared/utils/networkError';

import { isCalendarWritable } from '../utils/sharedCalendars';
import { canEditCalDavTask, isCalDavTaskConflict, moveCalDavTask } from '../utils/caldavTaskApi';
import { calDavLoadError } from '../utils/loadCalDavCalendar';
import { isCreatedEvent, payloadAttendees, useEventCreation } from './useEventCreation';

const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true';
const CALENDAR_NAVIGATION_KEY = 'courrier-calendar-navigation-v1';
const CALENDAR_VIEWS: ViewType[] = ['day', 'workweek', 'week', 'month'];

function loadCalendarNavigation(): { view: ViewType; date: Date } {
  try {
    const saved = JSON.parse(localStorage.getItem(CALENDAR_NAVIGATION_KEY) ?? '{}') as { view?: string; periodStart?: string };
    const date = saved.periodStart ? new Date(saved.periodStart) : new Date();
    return {
      view: CALENDAR_VIEWS.includes(saved.view as ViewType) ? saved.view as ViewType : 'week',
      date: Number.isNaN(date.getTime()) ? new Date() : date,
    };
  } catch {
    return { view: 'week', date: new Date() };
  }
}

function periodStart(date: Date, view: ViewType): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  if (view === 'month') start.setDate(1);
  if (view === 'week' || view === 'workweek') {
    const day = start.getDay();
    start.setDate(start.getDate() + (day === 0 ? -6 : 1 - day));
  }
  return start;
}

export interface TUICalendarInstance {
  prev(): void;
  next(): void;
  today(): void;
  setDate(date: Date): void;
  getDate(): { toDate(): Date };
  clearGridSelections(): void;
}

export interface CalendarRef {
  getInstance(): TUICalendarInstance | null;
}

export function useCalendarLogic() {
  const calendarRef = useRef<CalendarRef>(null);
  const queryClient = useQueryClient();
  const initialNavigation = useMemo(loadCalendarNavigation, []);
  const [view, setView] = useState<ViewType>(initialNavigation.view);
  const [currentDate, setCurrentDate] = useState(initialNavigation.date);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    localStorage.getItem('sidebar-collapsed') === 'true'
  );
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = localStorage.getItem('sidebar-width');
    return stored ? Number(stored) : 260;
  });
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;

  useEffect(() => {
    localStorage.setItem(CALENDAR_NAVIGATION_KEY, JSON.stringify({
      view,
      periodStart: periodStart(currentDate, view).toISOString(),
    }));
  }, [currentDate, view]);

  const handleCollapseToggle = useCallback(() => {
    setSidebarCollapsed((v) => {
      const next = !v;
      localStorage.setItem('sidebar-collapsed', String(next));
      return next;
    });
  }, []);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidthRef.current;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (ev: globalThis.MouseEvent) => {
      const newWidth = Math.min(Math.max(startWidth + ev.clientX - startX, 160), 480);
      setSidebarWidth(newWidth);
    };

    const onMouseUp = (ev: globalThis.MouseEvent) => {
      const newWidth = Math.min(Math.max(startWidth + ev.clientX - startX, 160), 480);
      localStorage.setItem('sidebar-width', String(newWidth));
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  const { calendars: realCalendars, toggleCalendar, updateCalendar, reorderCalendars } = useCalendars();
  const { groups, addGroup, removeGroup, updateGroup } = useCalendarGroups();
  const { tags, eventTags, addTag, removeTag, updateTag, setEventTag, removeEventTag, refreshTags, isSynchronizing: tagsSynchronizing } = useTags();
  const androidCalendars = useAndroidCalendars();
  const sourceCalendars = DEMO_MODE || androidCalendars ? [] : realCalendars;
  const fallbackIcs = useICSEvents(sourceCalendars);
  const fallbackGoogle = useGoogleEvents(sourceCalendars);
  const fallbackNextcloud = useNextcloudEvents(sourceCalendars);
  const fallbackEws = useEWSEvents(sourceCalendars);
  const { events: icsEvents, loading: icsLoading, errors: icsErrors, refresh: icsRefresh } = androidCalendars?.ics ?? fallbackIcs;
  const { events: googleEvents, loading: googleLoading, errors: googleErrors, refresh: googleRefresh, refreshCreated: googleRefreshCreated } = androidCalendars?.google ?? fallbackGoogle;
  const { events: ncEvents, loading: ncLoading, errors: ncErrors, refresh: ncRefresh, refreshCreated: ncRefreshCreated, readOnlyCalendarIds = [] } = androidCalendars?.nextcloud ?? fallbackNextcloud;
  const { events: ewsEvents, loading: ewsLoading, errors: ewsErrors, refresh: ewsRefresh } = androidCalendars?.ews ?? fallbackEws;
  const { getValidToken } = useGoogleAuth();
  const { accounts: exchangeAccounts, getValidToken: getExchangeToken, getRefreshToken: getExchangeRefreshToken } = useExchangeAuth();
  const { resolved: theme } = useTheme();

  const [createModalState, setCreateModalState] = useState<{ start: string; end: string } | null>(null);
  const [editEvent, setEditEvent] = useState<CalendarEvent | null>(null);
  const [deletedEventIds, setDeletedEventIds] = useState<Set<string>>(new Set());
  const [optimisticUpdated, setOptimisticUpdated] = useState<Map<string, CalendarEvent>>(new Map());
  const [showRecurringModal, setShowRecurringModal] = useState(false);
  const recurringChoiceResolveRef = useRef<((scope: 'this' | 'all' | null) => void) | null>(null);

  const calendars = useMemo(() => DEMO_MODE ? DEMO_CALENDARS : realCalendars.map(cal =>
    readOnlyCalendarIds.includes(cal.id) ? { ...cal, readOnly: true } : cal), [realCalendars, readOnlyCalendarIds]);
  const allEventsRaw = DEMO_MODE ? DEMO_EVENTS : [...icsEvents, ...googleEvents, ...ncEvents, ...ewsEvents];
  const creation = useEventCreation(allEventsRaw);
  const optimisticCreated = creation.created;
  const events = useMemo(() => {
    const serverEvents = allEventsRaw
      .filter((e: CalendarEvent) => !deletedEventIds.has(e.id))
      .map((e: CalendarEvent) => optimisticUpdated.get(e.id) ?? e);
    // Only a server identifier can replace a creation, not a similar title/date.
    const pendingCreated = optimisticCreated.filter((opt) =>
      !serverEvents.some(
         (sv) => isCreatedEvent(sv, opt),
      ),
    );
    return [...serverEvents, ...pendingCreated
      .filter(event => !deletedEventIds.has(event.id))
      .map(event => optimisticUpdated.get(event.id) ?? event)];
  }, [allEventsRaw, deletedEventIds, optimisticUpdated, optimisticCreated]);

  // Keep selectedEvent in sync when the underlying event changes.
  // Handles both: server-side data refresh (same id) and optimistic→real
  // transition after creation (temp-xxx id → real server id).
  useEffect(() => {
    if (!selectedEvent) return;
    const byId = events.find((e) => e.id === selectedEvent.id);
    if (byId) {
      if (byId !== selectedEvent) setSelectedEvent(byId);
      return;
    }
    if (selectedEvent.id.startsWith('temp-')) {
      if (creation.operations.some(op => op.id === selectedEvent.id && op.state === 'failed')) {
        setSelectedEvent(null);
        return;
      }
      const real = events.find(
        (e) =>
          !e.id.startsWith('temp-') &&
            isCreatedEvent(e, { ...selectedEvent, sourceId: creation.sourceIdFor(selectedEvent.id) }),
      );
      if (real) setSelectedEvent(real);
    }
  }, [events, selectedEvent, creation.operations]);

  const loading = DEMO_MODE ? false : (icsLoading || googleLoading || ncLoading || ewsLoading || !!tagsSynchronizing);
  const [taskMoveErrors, setTaskMoveErrors] = useState<Record<string, string>>({});
  const taskMoves = useRef(new Set<string>());
  const errors = useMemo(() => {
    if (DEMO_MODE) return {};
    return Object.fromEntries(
      Object.entries({ ...icsErrors, ...googleErrors, ...ncErrors, ...ewsErrors, ...taskMoveErrors })
        .filter(([, error]) => !isOfflineLikeError(error)),
    );
  }, [icsErrors, googleErrors, ncErrors, ewsErrors, taskMoveErrors]);
  const refresh = useCallback(async () => {
    await Promise.all([
      Promise.resolve(icsRefresh()),
      Promise.resolve(googleRefresh()),
      Promise.resolve(ncRefresh()),
      ewsRefresh(),
      // The vault exposes tag-sync failures through its existing sync status;
      // an unavailable WebDAV must not fail the calendar refresh itself.
      refreshTags().catch(() => {}),
    ]);
  }, [icsRefresh, googleRefresh, ncRefresh, ewsRefresh, refreshTags]);

  const handlePrev = useCallback(() => {
    const inst = calendarRef.current?.getInstance();
    if (inst) {
      inst.prev();
      setCurrentDate(inst.getDate().toDate());
    }
  }, []);

  const handleNext = useCallback(() => {
    const inst = calendarRef.current?.getInstance();
    if (inst) {
      inst.next();
      setCurrentDate(inst.getDate().toDate());
    }
  }, []);

  const handleToday = useCallback(() => {
    const inst = calendarRef.current?.getInstance();
    if (inst) {
      inst.today();
      setCurrentDate(inst.getDate().toDate());
    }
  }, []);

  const handleNavigateToDate = useCallback((date: Date) => {
    calendarRef.current?.getInstance()?.setDate(date);
    setCurrentDate(date);
  }, []);

  const syncDate = useCallback(() => {
    const d = calendarRef.current?.getInstance()?.getDate().toDate();
    if (d) setCurrentDate(d);
  }, []);

  const handleViewChange = useCallback((v: ViewType) => {
    setView(v);
    setTimeout(syncDate, 50);
  }, [syncDate]);

  const saveNextcloudEvent = useCallback(async (cal: CalendarConfig, payload: CreateEventPayload, sourceEvent?: CalendarEvent, wholeSeries = false): Promise<string | undefined> => {
    if (sourceEvent?.sourceId) {
      await updateNextcloudEvent(cal, sourceEvent.sourceId, payload, sourceEvent, wholeSeries);
      return sourceEvent.seriesId;
    } else {
      return await createNextcloudEvent(cal, payload);
    }
  }, []);

  const saveExchangeEvent = useCallback(async (cal: CalendarConfig, payload: CreateEventPayload, sourceEvent?: CalendarEvent, updateSeries = false): Promise<string | undefined> => {
    if (!cal.exchangeAccountId) throw new Error('Compte Exchange introuvable');
    const token = await getExchangeToken(cal.exchangeAccountId);
    if (!token) throw new Error(i18n.t('calendarPage.invalidToken'));
    const attendeeEmails = payload.attendees?.filter(a => !a.optional).map((a) => a.email) ?? [];
    const optionalAttendees = payload.attendees?.filter(a => a.optional).map(a => a.email) ?? [];
    if (sourceEvent?.sourceId) {
      const [itemId, changeKey] = sourceEvent.sourceId.split('|');
      await queryClient.cancelQueries({ queryKey: CALENDAR_KEYS.events(cal.id) });
      await exchangeCalendarApi.update({
        accessToken: token,
        itemId,
        changeKey,
        availability: payload.availability,
        sensitivity: payload.sensitivity,
        eventType: payload.eventType,
        title: payload.title,
        start: payload.start,
        end: payload.end,
        isAllDay: payload.isAllday,
        location: payload.location ?? null,
        description: payload.description ?? null,
        attendees: attendeeEmails,
        optionalAttendees,
        originalStart: updateSeries ? sourceEvent.start : undefined,
        updateSeries,
        recurrence: payload.recurrence,
      });
      return sourceEvent.seriesId;
    } else {
      const result = await exchangeCalendarApi.create({
        accessToken: token,
        onlineMeeting: payload.onlineMeeting,
        refreshToken: payload.onlineMeeting ? getExchangeRefreshToken(cal.exchangeAccountId) : undefined,
        availability: payload.availability,
        sensitivity: payload.sensitivity,
        eventType: payload.eventType,
        title: payload.title,
        start: payload.start,
        end: payload.end,
        isAllDay: payload.isAllday,
        location: payload.location ?? null,
        description: payload.description ?? null,
        attendees: attendeeEmails.length > 0 ? attendeeEmails : null,
        optionalAttendees,
        recurrence: payload.recurrence,
      });
      return result.split('|')[0];
    }
  }, [getExchangeToken, getExchangeRefreshToken, queryClient]);

  const saveGoogleEvent = useCallback(async (cal: CalendarConfig, payload: CreateEventPayload, sourceEvent?: CalendarEvent, originalOccurrenceStart?: string): Promise<string | undefined> => {
    if (!cal.googleAccountId) throw new Error('Compte Google introuvable');
    const token = await getValidToken(cal.googleAccountId);
    if (!token) throw new Error('Token invalide. Reconnectez votre compte Google.');
    if (sourceEvent?.sourceId) {
      await updateEvent(token, cal, sourceEvent.sourceId, payload, originalOccurrenceStart);
      return sourceEvent.seriesId;
    } else {
      return await createEvent(token, cal, payload);
    }
  }, [getValidToken]);

  const loadEventRecurrence = useCallback(async (event: CalendarEvent): Promise<string | null> => {
    const cal = calendars.find(c => c.id === event.calendarId);
    if (!cal || event.readOnly || !event.sourceId) return null;
    if (cal.type === 'nextcloud') return getNextcloudRecurrence(cal, event.sourceId);
    if (cal.type === 'exchange' && cal.exchangeAccountId) {
      const token = await getExchangeToken(cal.exchangeAccountId);
      if (!token) throw new Error(i18n.t('calendarPage.invalidToken'));
      return exchangeCalendarApi.recurrence({ accessToken: token, itemId: event.sourceId.split('|')[0] });
    }
    if (cal.type === 'google' && cal.googleAccountId && event.seriesId) {
      const token = await getValidToken(cal.googleAccountId);
      if (!token) throw new Error(i18n.t('calendarPage.invalidToken'));
      return getGoogleRecurrence(token, cal, event.seriesId);
    }
    return null;
  }, [calendars, getExchangeToken, getValidToken]);

  const handleSaveEvent = useCallback(async (payload: CreateEventPayload, sourceEvent?: CalendarEvent, recurringScope?: 'this' | 'future') => {
    const cal = calendars.find((c) => c.id === payload.calendarId);
    if (!cal) throw new Error(i18n.t('calendarPage.calendarNotFound'));
    if (sourceEvent?.readOnly || sourceEvent?.isTask || !isCalendarWritable(cal)) throw new Error(i18n.t('sharedCalendars.readOnly'));

    const seriesSourceEvent = recurringScope === 'future' && sourceEvent?.seriesId && cal.type !== 'exchange'
      ? { ...sourceEvent, sourceId: sourceEvent.seriesId }
      : sourceEvent;
    const doSave = () => {
      if (cal.type === 'nextcloud') return saveNextcloudEvent(cal, payload, sourceEvent, recurringScope === 'future');
      if (cal.type === 'exchange') return saveExchangeEvent(cal, payload, sourceEvent, recurringScope === 'future');
      return saveGoogleEvent(cal, payload, seriesSourceEvent, recurringScope === 'future' ? sourceEvent?.start : undefined);
    };
    const doRefresh = async () => {
      if (cal.type === 'nextcloud') await ncRefresh(cal.id);
      else if (cal.type === 'exchange') await ewsRefresh(cal.id);
      else await googleRefresh(cal.id);
    };

    if (sourceEvent) {
      const optimistic: CalendarEvent = {
        ...sourceEvent,
        availability: payload.availability,
        sensitivity: payload.sensitivity,
        eventType: payload.eventType,
        title: payload.title,
        start: payload.start,
        end: payload.end,
        isAllday: payload.isAllday,
        category: payload.isAllday ? 'allday' : 'time',
        location: payload.location,
         description: payload.description,
         attendees: payloadAttendees(payload, sourceEvent) ?? sourceEvent.attendees,
        tagId: payload.tagId ?? undefined,
      };
      setOptimisticUpdated((prev) => new Map(prev).set(sourceEvent.id, optimistic));
      try {
        const sid = await doSave();
        const finalSeriesId = sid ?? sourceEvent.seriesId ?? sourceEvent.sourceId;
        if (finalSeriesId) {
          if (payload.tagId) setEventTag(finalSeriesId, payload.tagId);
          else if (payload.tagId === null) removeEventTag(finalSeriesId);
        }
        void doRefresh().finally(() => {
          setOptimisticUpdated((prev) => { const n = new Map(prev); n.delete(sourceEvent.id); return n; });
        });
      } catch (e) {
        setOptimisticUpdated((prev) => { const n = new Map(prev); n.delete(sourceEvent.id); return n; });
        throw e;
      }
    } else {
      let taggedSourceId: string | undefined;
      creation.begin(payload, doSave, async sourceId => {
        if (sourceId) {
          if (cal.type === 'nextcloud') return ncRefreshCreated(cal.id, sourceId);
          if (cal.type === 'google') return googleRefreshCreated(cal.id, sourceId);
          const token = await getExchangeToken(cal.exchangeAccountId!);
          if (!token) throw new Error(i18n.t('calendarPage.invalidToken'));
          const incoming = await fetchEWSItem(cal, token, sourceId, payload.start, payload.end, !!payload.recurrence);
          if (queryClient.getQueryData(CALENDAR_KEYS.events(cal.id)) !== undefined) {
            await queryClient.cancelQueries({ queryKey: CALENDAR_KEYS.events(cal.id) });
            queryClient.setQueryData<CalendarEvent[]>(CALENDAR_KEYS.events(cal.id), cached => mergeCreatedEvents(cached ?? [], incoming, cal.id, sourceId));
          }
          return incoming;
        }
        if (cal.type === 'nextcloud') return (await ncRefresh(cal.id)) ?? [];
        if (cal.type === 'google') return (await googleRefresh(cal.id)) ?? [];
        await ewsRefresh(cal.id);
        const query = queryClient.getQueryState(CALENDAR_KEYS.events(cal.id));
        if (query?.status === 'error') throw query.error;
        return queryClient.getQueryData<CalendarEvent[]>(CALENDAR_KEYS.events(cal.id)) ?? [];
      }, sid => {
        if (payload.tagId && sid) {
          if (taggedSourceId && taggedSourceId !== sid) removeEventTag(taggedSourceId);
          setEventTag(sid, payload.tagId);
          taggedSourceId = sid;
        }
      });
    }
  }, [calendars, saveNextcloudEvent, saveExchangeEvent, saveGoogleEvent, ncRefresh, ewsRefresh, googleRefresh, setEventTag, removeEventTag, creation.begin, queryClient, getExchangeToken, googleRefreshCreated, ncRefreshCreated]);

  const isEventRecurring = useCallback((event: CalendarEvent): boolean => {
    const result = event.isRecurringInstance === true;
    console.log('[recurring] isEventRecurring', { id: event.id, title: event.title, isRecurringInstance: event.isRecurringInstance, result });
    return result;
  }, []);

  const askRecurringScope = useCallback((): Promise<'this' | 'all' | null> => {
    console.log('[recurring] askRecurringScope: setting showRecurringModal=true');
    return new Promise((resolve) => {
      recurringChoiceResolveRef.current = resolve;
      setShowRecurringModal(true);
    });
  }, []);

  const handleRecurringModalChoice = useCallback((scope: 'this' | 'all' | null) => {
    console.log('[recurring] handleRecurringModalChoice scope=', scope);
    setShowRecurringModal(false);
    recurringChoiceResolveRef.current?.(scope);
    recurringChoiceResolveRef.current = null;
  }, []);

  const handleRsvp = useCallback(async (
    event: CalendarEvent,
    status: 'ACCEPTED' | 'DECLINED' | 'TENTATIVE',
    comment?: string,
  ) => {
    const cal = calendars.find((c) => c.id === event.calendarId);
    if (!cal) throw new Error(i18n.t('calendarPage.calendarNotFound'));
    if (event.readOnly || event.isTask || !isCalendarWritable(cal)) throw new Error(i18n.t('sharedCalendars.readOnly'));

    let rsvpSourceId = event.sourceId;
    let respondSeries = false;
    let affectedIds = [event.id];

    if (isEventRecurring(event)) {
      const scope = await askRecurringScope();
      if (scope === null) return;
      if (scope === 'all' && event.seriesId) {
        respondSeries = true;
        if (cal.type !== 'exchange') rsvpSourceId = event.seriesId;
        affectedIds = events.filter((e) => e.seriesId === event.seriesId).map((e) => e.id);
      }
    }

    const makeOptimistic = (ev: CalendarEvent): CalendarEvent => ({
      ...ev,
      selfRsvpStatus: status,
      isDeclined: status === 'DECLINED',
      isUnaccepted: status !== 'ACCEPTED',
    });

    setOptimisticUpdated((prev) => {
      const n = new Map(prev);
      for (const id of affectedIds) {
        const ev = events.find((e) => e.id === id);
        if (ev) n.set(id, makeOptimistic(ev));
      }
      return n;
    });
    setSelectedEvent(makeOptimistic(event));

    try {
      if (cal.type === 'google') {
        if (!cal.googleAccountId || !rsvpSourceId || !cal.ownerEmail)
          throw new Error(i18n.t('calendarPage.missingInfo'));
        const token = await getValidToken(cal.googleAccountId);
        if (!token) throw new Error(i18n.t('calendarPage.invalidToken'));
        await respondToGoogleEvent(token, cal, rsvpSourceId, cal.ownerEmail, status, comment);
        await googleRefresh(cal.id);
      } else if (cal.type === 'nextcloud') {
        if (!event.sourceId || !cal.ownerEmail)
          throw new Error(i18n.t('calendarPage.missingInfo'));
        await respondToNextcloudEvent(cal, event.sourceId, cal.ownerEmail, status, comment);
        await ncRefresh(cal.id);
      } else if (cal.type === 'exchange') {
        if (!cal.exchangeAccountId || !rsvpSourceId)
          throw new Error(i18n.t('calendarPage.missingInfo'));
        const token = await getExchangeToken(cal.exchangeAccountId);
        if (!token) throw new Error(i18n.t('calendarPage.invalidToken'));
        const [itemId, changeKey] = rsvpSourceId.split('|');
        if (!itemId || !changeKey) throw new Error(i18n.t('calendarPage.missingInfo'));
        console.info('[Exchange RSVP] Envoi', { itemId, status });
        await exchangeCalendarApi.respond({
          accessToken: token,
          itemId,
          changeKey,
          respondSeries,
          responseType: status === 'ACCEPTED' ? 'accept' : status === 'DECLINED' ? 'decline' : 'tentative',
          ownerEmail: cal.ownerEmail,
          body: comment ?? null,
        });
        console.info('[Exchange RSVP] Réponse confirmée par EWS', { status });
        const affectedIdSet = new Set(affectedIds);
        queryClient.setQueryData<CalendarEvent[]>(CALENDAR_KEYS.events(cal.id), (cached) =>
          cached?.map((cachedEvent) => affectedIdSet.has(cachedEvent.id) ? makeOptimistic(cachedEvent) : cachedEvent),
        );
        setOptimisticUpdated((prev) => {
          const next = new Map(prev);
          for (const id of affectedIds) next.delete(id);
          return next;
        });
      }
    } catch (e) {
      setOptimisticUpdated((prev) => {
        const n = new Map(prev);
        for (const id of affectedIds) n.delete(id);
        return n;
      });
      setSelectedEvent(event);
      throw e;
    }
  }, [calendars, events, isEventRecurring, askRecurringScope, getValidToken, getExchangeToken, googleRefresh, ncRefresh, queryClient]);

  const deleteOrCancelEvent = useCallback(async (event: CalendarEvent, requestedScope?: 'this' | 'all', sendCancellation = false) => {
    const cal = calendars.find((c) => c.id === event.calendarId);
    console.log('[recurring] handleDeleteEvent cal=', cal?.type, 'event.isRecurringInstance=', event.isRecurringInstance, 'seriesId=', event.seriesId);
    if (!cal) return;
    if (event.readOnly || event.isTask || !isCalendarWritable(cal)) throw new Error(i18n.t('sharedCalendars.readOnly'));

    let deleteSourceId = event.sourceId;
    let affectedIds = [event.id];

    let recurringScope = requestedScope;
    if (isEventRecurring(event) && !recurringScope) {
      console.log('[recurring] event IS recurring → showing scope modal');
      const scope = await askRecurringScope();
      if (scope === null) {
        const err = new Error('CANCELLED') as Error & { cancelled: true };
        err.cancelled = true;
        throw err;
      }
      recurringScope = scope;
    }
    if (recurringScope === 'all' && event.seriesId) {
      deleteSourceId = event.seriesId;
      affectedIds = events.filter((e) => e.seriesId === event.seriesId).map((e) => e.id);
    }

    const cancellationRemovesEvent = sendCancellation && cal.type === 'exchange';
    if (sendCancellation && !cancellationRemovesEvent) {
      setOptimisticUpdated((prev) => {
        const next = new Map(prev);
        for (const id of affectedIds) {
          const affected = events.find((candidate) => candidate.id === id);
          if (affected) next.set(id, { ...affected, isCancelled: true });
        }
        return next;
      });
    } else {
      setDeletedEventIds((prev) => new Set([...prev, ...affectedIds]));
    }

    try {
      console.log('[deleteEvent] sourceId=', event.sourceId, 'deleteSourceId=', deleteSourceId, 'cal.type=', cal.type, 'event.id=', event.id);
      if (cal.type === 'google') {
        const token = await getValidToken(cal.googleAccountId!);
        await deleteGoogleEvent(token!, cal, deleteSourceId!, sendCancellation);
        await googleRefresh(cal.id);
      } else if (cal.type === 'nextcloud') {
        if (sendCancellation) await cancelNextcloudEvent(cal, event.sourceId!, event, recurringScope === 'all');
        else await deleteNextcloudEvent(cal, event.sourceId!);
        await ncRefresh(cal.id);
      } else if (cal.type === 'exchange') {
        const token = await getExchangeToken(cal.exchangeAccountId!);
        const [itemId, changeKey] = event.sourceId!.split('|');
        console.log('[deleteEvent] exchange itemId=', itemId, 'changeKey=', changeKey);
        if (sendCancellation) {
          await exchangeCalendarApi.cancel({
            accessToken: token,
            itemId,
            changeKey,
            cancelSeries: recurringScope === 'all',
          });
        } else {
          await exchangeCalendarApi.delete({
            accessToken: token,
            itemId,
            changeKey,
            sendCancellations: false,
            deleteSeries: recurringScope === 'all',
          });
        }
        await ewsRefresh(cal.id);
      }
      if (sendCancellation && !cancellationRemovesEvent) {
        setOptimisticUpdated((prev) => {
          const next = new Map(prev);
          for (const id of affectedIds) next.delete(id);
          return next;
        });
      }
      if (!sendCancellation || cancellationRemovesEvent) {
        setDeletedEventIds((prev) => {
          const next = new Set(prev);
          for (const id of affectedIds) next.delete(id);
          return next;
        });
      }
    } catch (err) {
      console.error('[deleteEvent] failed', err);
      const message = String(err).toLowerCase();
      const alreadyMissingOnEws = cal.type === 'exchange' && (
        message.includes("item not found") ||
        message.includes("occurrence couldn't be found") ||
        message.includes('erroritemnotfound')
      );
      if (alreadyMissingOnEws) {
        void ewsRefresh(cal.id);
        return;
      }
      if (sendCancellation && !cancellationRemovesEvent) {
        setOptimisticUpdated((prev) => {
          const next = new Map(prev);
          for (const id of affectedIds) next.delete(id);
          return next;
        });
      } else {
        setDeletedEventIds((prev) => {
          const next = new Set(prev);
          for (const id of affectedIds) next.delete(id);
          return next;
        });
      }
      throw new Error(i18n.t('eventModal.deleteError'));
    }
  }, [calendars, events, exchangeAccounts, isEventRecurring, askRecurringScope, getValidToken, getExchangeToken, googleRefresh, ncRefresh, ewsRefresh]);

  const handleDeleteEvent = useCallback(
    (event: CalendarEvent, scope?: 'this' | 'all') => deleteOrCancelEvent(event, scope, false),
    [deleteOrCancelEvent],
  );

  const handleCancelEvent = useCallback(
    (event: CalendarEvent, scope?: 'this' | 'all') => deleteOrCancelEvent(event, scope, true),
    [deleteOrCancelEvent],
  );

  const isExchangeOrganizer = useCallback((event: CalendarEvent) => {
    const cal = calendars.find(c => c.id === event.calendarId);
    return !!cal && cal.type === 'exchange' && isEventOrganizer(event, cal, exchangeAccounts);
  }, [calendars, exchangeAccounts]);

  const isEventEditable = useCallback((event: CalendarEvent) =>
    canEditEvent(event, calendars.find(c => c.id === event.calendarId), exchangeAccounts),
  [calendars, exchangeAccounts]);

  const handleStartEdit = useCallback(async (event: CalendarEvent) => {
    if (event.readOnly || event.isTask) return;
    setEditEvent(event);
    setSelectedEvent(null);
  }, []);

  const handleBeforeUpdateEvent = useCallback(
    ({ event, changes }: { event: any; changes: any }) => {
      const originalEvent = events.find((e) => e.id === event.id);
      if (!originalEvent) return;
      if (originalEvent.isTask) {
        const cal = calendars.find(candidate => candidate.id === originalEvent.calendarId);
        if (!cal || !canEditCalDavTask(originalEvent, cal) || !changes.start || taskMoves.current.has(originalEvent.id)) return;
        const value = changes.start;
        const target = value instanceof Date ? value : typeof value.toDate === 'function' ? value.toDate() : new Date(String(value));
        if (Number.isNaN(target.getTime())) return;
        taskMoves.current.add(originalEvent.id);
        setTaskMoveErrors(previous => { const next = { ...previous }; delete next[cal.id]; return next; });
        void moveCalDavTask(originalEvent, cal, target).then(() => ncRefresh(cal.id)).catch(cause => {
          setTaskMoveErrors(previous => ({ ...previous, [cal.id]: isCalDavTaskConflict(cause) ? i18n.t('caldavTask.moveConflict') : calDavLoadError(cause) }));
          void ncRefresh(cal.id);
        }).finally(() => taskMoves.current.delete(originalEvent.id));
        return;
      }
      if (!isEventEditable(originalEvent)) return;

      const toISO = (d: unknown): string => {
        if (d instanceof Date) return d.toISOString();
        if (d && typeof (d as any).toDate === 'function') return (d as any).toDate().toISOString();
        return String(d);
      };

      const newStart = changes.start ? toISO(changes.start) : originalEvent.start;
      let newEnd: string;
      if (changes.end) {
        newEnd = toISO(changes.end);
      } else if (changes.start) {
        const duration = new Date(originalEvent.end).getTime() - new Date(originalEvent.start).getTime();
        newEnd = new Date(new Date(newStart).getTime() + duration).toISOString();
      } else {
        newEnd = originalEvent.end;
      }

      if (originalEvent.isAllday && changes.end) {
        const d = new Date(newEnd);
        d.setDate(d.getDate() + 1);
        newEnd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }

      const payload: CreateEventPayload = {
        availability: originalEvent.availability,
        sensitivity: originalEvent.sensitivity,
        eventType: originalEvent.eventType,
        title: originalEvent.title,
        start: newStart,
        end: newEnd,
        isAllday: originalEvent.isAllday,
        calendarId: originalEvent.calendarId,
        location: originalEvent.location,
        description: originalEvent.description,
        attendees: originalEvent.attendees?.map((a) => ({ email: a.email, name: a.name, optional: a.optional })),
      };

      void (async () => {
        let recurringScope: 'this' | 'future' | undefined;
        if (isEventRecurring(originalEvent)) {
          const scope = await askRecurringScope();
          if (scope === null) return;
          recurringScope = scope === 'all' ? 'future' : 'this';
        }
        await handleSaveEvent(payload, originalEvent, recurringScope);
      })();
    },
    [events, calendars, ncRefresh, isEventEditable, isEventRecurring, askRecurringScope, handleSaveEvent]
  );

  return {
    calendarRef,
    view,
    setView,
    currentDate,
    setCurrentDate,
    selectedEvent,
    setSelectedEvent,
    sidebarCollapsed,
    sidebarWidth,
    handleCollapseToggle,
    handleResizeStart,
    calendars,
    toggleCalendar,
    updateCalendar,
    reorderCalendars: (ordered: CalendarConfig[]) => reorderCalendars(ordered.map(({ readOnly: _readOnly, ...cal }) => cal)),
    groups,
    addGroup,
    removeGroup,
    updateGroup,
    tags,
    eventTags,
    addTag,
    removeTag,
    updateTag,
    setEventTag,
    removeEventTag,
    events,
    loading,
    errors,
    refresh,
    theme,
    createModalState,
    setCreateModalState,
    editEvent,
    setEditEvent,
    handlePrev,
    handleNext,
    handleToday,
    getValidToken,
    getExchangeRefreshToken,
    getExchangeToken,
    handleNavigateToDate,
    handleViewChange,
    handleSaveEvent,
    eventCreations: creation.operations,
    dismissEventCreation: creation.dismiss,
    retryEventCreation: creation.retry,
    recheckEventCreation: creation.recheck,
    loadEventRecurrence,
    handleRsvp,
    handleDeleteEvent,
    handleCancelEvent,
    handleStartEdit,
    isEventEditable,
    isExchangeOrganizer,
    handleBeforeUpdateEvent,
    showRecurringModal,
    handleRecurringModalChoice,
  };
}
