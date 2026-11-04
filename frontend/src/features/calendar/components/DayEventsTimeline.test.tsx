// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { DayEventsTimeline } from './DayEventsTimeline';
import type { AttendeeStatus, CalendarEvent } from '../../../shared/types';
import '../../../i18n';

it.each<AttendeeStatus>(['NEEDS-ACTION', 'ACCEPTED', 'TENTATIVE', 'DECLINED'])('keeps invitation highlight colours controlled by CSS for %s', async status => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const event: CalendarEvent = { id: 'invitation', calendarId: 'calendar', title: 'Invitation', start: '2026-10-23T10:00:00', end: '2026-10-23T11:00:00', isAllday: false, category: 'time', selfRsvpStatus: status };
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<DayEventsTimeline events={[event, { ...event, id: 'other' }]} calendars={[]} targetDate={new Date(event.start)} highlightedEventId={event.id} />));
    const highlighted = host.querySelector<HTMLButtonElement>('.det-event--highlighted')!;
    expect(highlighted.style.backgroundColor).toBe('');
    expect(highlighted.style.color).toBe('');
    expect(highlighted.classList.contains(`det-event--rsvp-${status.toLowerCase()}`)).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('.det-event:not(.det-event--highlighted)')!.style.backgroundColor).not.toBe('');
    highlighted.focus();
    expect(document.activeElement).toBe(highlighted);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
