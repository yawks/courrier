import { useEffect, useRef, useState } from 'react';
import type { CalendarEvent, CreateEventPayload } from '../../../shared/types';

export type CreationState = 'saving' | 'checking' | 'saved' | 'refreshFailed' | 'failed' | 'uncertain';
export interface EventCreation {
  id: string;
  payload: CreateEventPayload;
  state: CreationState;
}

export function payloadAttendees(payload: CreateEventPayload, previous?: CalendarEvent) {
  return payload.attendees?.map(attendee => {
    const saved = previous?.attendees?.find(a => a.email.toLowerCase() === attendee.email.toLowerCase());
    return {
      ...saved, ...attendee,
      name: attendee.name || saved?.name || attendee.email,
      status: saved?.status ?? 'NEEDS-ACTION' as const,
    };
  });
}

export function isCreatedEvent(event: CalendarEvent, optimistic: CalendarEvent) {
  return event.calendarId === optimistic.calendarId && !!optimistic.sourceId && (
    event.sourceId?.split('|')[0] === optimistic.sourceId.split('|')[0] ||
    event.seriesId === optimistic.sourceId || event.icalUid === optimistic.sourceId
  );
}

function confirmedFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /Error(AccessDenied|Invalid\w*|NonExistentMailbox|Calendar\w*|Mailbox\w*)|Invalid |invalidToken|Unauthorized|Forbidden|\b40[0134]\b|teams_auth_required|teams_missing_link/.test(message);
}

function matchesPayload(event: CalendarEvent, payload: CreateEventPayload) {
  const emails = (event.attendees ?? []).filter(a => !a.isOrganizer);
  return event.calendarId === payload.calendarId && event.title === payload.title &&
    new Date(event.start).getTime() === new Date(payload.start).getTime() &&
    new Date(event.end).getTime() === new Date(payload.end).getTime() &&
    (payload.attendees ?? []).every(a => emails.some(b => b.email.toLowerCase() === a.email.toLowerCase() && !!b.optional === !!a.optional));
}

/** Creation owns its background request: closing the form never drops errors or confirmation. */
export function useEventCreation(serverEvents: CalendarEvent[]) {
  const [created, setCreated] = useState<CalendarEvent[]>([]);
  const [operations, setOperations] = useState<EventCreation[]>([]);
  const active = useRef(new Set<CreateEventPayload>());
  const retries = useRef(new Map<string, () => void>());
  const checks = useRef(new Map<string, () => Promise<void>>());
  const checking = useRef(new Set<string>());
  const sources = useRef(new Map<string, string>());
  const serverRef = useRef(serverEvents);
  serverRef.current = serverEvents;
  useEffect(() => {
    setCreated(current => {
      const pending = current.filter(event => !serverEvents.some(server => isCreatedEvent(server, event)));
      return pending.length === current.length ? current : pending;
    });
  }, [serverEvents]);

  function begin(payload: CreateEventPayload, save: () => Promise<string | undefined>, refresh: (sourceId?: string) => Promise<CalendarEvent[]>, onSaved: (id?: string) => void) {
    if (active.current.has(payload)) return;
    active.current.add(payload);
    const id = `temp-${crypto.randomUUID()}`;
    const existingIds = new Set(serverRef.current.map(event => event.id));
    const event: CalendarEvent = {
      ...payload, id, category: payload.isAllday ? 'allday' : 'time',
      attendees: payloadAttendees(payload), tagId: payload.tagId ?? undefined,
      // No version token exists until the saved event has been read back.
      readOnly: true,
    };
    setCreated(current => [...current, event]);
    setOperations(current => [...current, { id, payload, state: 'saving' }]);
    const status = (state: CreationState) => setOperations(current => current.map(op => op.id === id ? { ...op, state } : op));
    const remove = () => setCreated(current => current.filter(ev => ev.id !== id));
    const bind = (sourceId: string) => {
      sources.current.set(id, sourceId);
      setCreated(current => current.map(ev => ev.id === id ? { ...ev, sourceId } : ev));
    };
    const reconcile = async () => {
      if (checking.current.has(id)) return;
      checking.current.add(id);
      status('checking');
      try {
        const refreshed = await refresh();
        const matches = refreshed.filter(ev => !existingIds.has(ev.id) && matchesPayload(ev, payload));
        if (matches.length === 1) {
          const sourceId = matches[0].sourceId?.split('|')[0] ?? matches[0].icalUid;
          if (sourceId) bind(sourceId);
          else remove();
          onSaved(sourceId);
          status('saved');
          checks.current.delete(id);
          return;
        }
      } catch { /* The outcome remains unknown; keep the provisional event visible. */ }
      finally { checking.current.delete(id); }
      status('uncertain');
    };
    void (async () => {
      let sourceId: string | undefined;
      try {
        sourceId = await save();
      } catch (error) {
        if (confirmedFailure(error)) {
          remove();
          status('failed');
          retries.current.set(id, () => {
            setOperations(current => current.filter(op => op.id !== id));
            retries.current.delete(id);
            begin(payload, save, refresh, onSaved);
          });
          return;
        }
        // A lost response may hide a successful creation. Never blindly repeat it.
        checks.current.set(id, reconcile);
        await reconcile();
        return;
      } finally {
        active.current.delete(payload);
      }
      if (sourceId) bind(sourceId);
      onSaved(sourceId);
      status('saved');
      const refreshSaved = async () => {
        if (checking.current.has(id)) return;
        checking.current.add(id);
        try {
          const refreshed = await refresh(sourceId);
          if (sourceId) {
            const first = refreshed[0];
            if (first?.sourceId) sources.current.set(id, first.sourceId.split('|')[0]);
            if (first?.seriesId && first.seriesId !== sourceId) onSaved(first.seriesId);
            // Replace the provisional item with server snapshots, including expanded occurrences.
            setCreated(current => current.flatMap(event => event.id === id ? refreshed : [event]));
          }
          status('saved');
          checks.current.delete(id);
        } catch {
          // The write succeeded: only retry the read, never the creation.
          status('refreshFailed');
          checks.current.set(id, async () => { status('checking'); await refreshSaved(); });
        } finally { checking.current.delete(id); }
      };
      await refreshSaved();
    })();
  }

  return {
    created: created.filter(event => !serverEvents.some(server => isCreatedEvent(server, event))),
    operations, begin,
    sourceIdFor: (id: string) => sources.current.get(id),
    retry: (id: string) => retries.current.get(id)?.(),
    recheck: (id: string) => { void checks.current.get(id)?.(); },
    dismiss: (id: string) => {
      retries.current.delete(id);
      checks.current.delete(id);
      setOperations(current => current.filter(op => op.id !== id));
    },
  };
}
