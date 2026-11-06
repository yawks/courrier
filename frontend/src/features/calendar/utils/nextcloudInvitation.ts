// @ts-ignore – ical.js v1 has no bundled types
import ICAL from 'ical.js';
import { t } from 'i18next';
import { calendarApi } from '../../../shared/api/calendarApi';
import type { CalendarConfig } from '../../../shared/types';
import { davResponses, sameOriginDavUrl } from './sharedCalendars';

const CALDAV = 'urn:ietf:params:xml:ns:caldav';
const xmlEscape = (value: string) => value.replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!);
const email = (value: unknown) => String(value ?? '').replace(/^mailto:/i, '').trim().toLowerCase();

/** Import the received invitation, preserving its identity; never create a new meeting. */
export async function respondToNextcloudInvitation(
  cal: CalendarConfig, icsText: string, selfEmail: string,
  status: 'ACCEPTED' | 'DECLINED' | 'TENTATIVE', recipientEmail?: string,
): Promise<void> {
  if (cal.shared || cal.readOnly) throw new Error(t('sharedCalendars.readOnly'));
  const invitation = new ICAL.Component(ICAL.parse(icsText));
  const events = invitation.getAllSubcomponents('vevent');
  const uid = events[0]?.getFirstPropertyValue('uid');
  const method = invitation.getFirstPropertyValue('method')?.toUpperCase();
  const published = method === 'PUBLISH';
  if (method && method !== 'REQUEST' && !published) {
    throw new Error(t('invitation.unsupportedMethod', { method }));
  }
  if (!uid) throw new Error(t('invitation.missingUid'));
  if (events.some((event: any) => event.getFirstPropertyValue('uid') !== uid)) {
    throw new Error(t('invitation.multipleEvents'));
  }
  if (events.some((event: any) => event.getFirstPropertyValue('status')?.toUpperCase() === 'CANCELLED')) {
    throw new Error(t('invitation.cancelled'));
  }
  if (!selfEmail.trim()) throw new Error(t('invitation.calendarEmailMissing'));
  if (!published && events.some((event: any) => !event.getFirstPropertyValue('organizer'))) {
    throw new Error(t('invitation.organizerMissing'));
  }
  if (!published && events.some((event: any) => email(event.getFirstPropertyValue('organizer')) === email(selfEmail))) {
    throw new Error(t('invitation.organizerIsAccount'));
  }
  const credentials = { url: cal.url, username: cal.nextcloudUsername ?? '', password: cal.nextcloudPassword ?? '' };
  const lookup = async () => {
    const xml = await calendarApi.queryCalDav(credentials, 'REPORT', '1',
      `<c:calendar-query xmlns:d="DAV:" xmlns:c="${CALDAV}"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:prop-filter name="UID"><c:text-match collation="i;octet">${xmlEscape(uid)}</c:text-match></c:prop-filter></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`);
    const resources = davResponses(xml).flatMap(({ href, prop }) => {
      const text = prop.getElementsByTagNameNS(CALDAV, 'calendar-data')[0]?.textContent;
      if (!text) return [];
      const component = new ICAL.Component(ICAL.parse(text));
      if (!component.getAllSubcomponents('vevent').some((event: any) => event.getFirstPropertyValue('uid') === uid)) return [];
      return [{ url: sameOriginDavUrl(cal.url, href), component,
        etag: prop.getElementsByTagNameNS('DAV:', 'getetag')[0]?.textContent?.trim() }];
    });
    if (resources.length > 1) throw new Error(t('invitation.calendarConflict'));
    return resources[0];
  };
  const existing = await lookup();
  const current = existing?.component ?? invitation;
  const targets = events.map((incoming: any) => {
    const target = current.getAllSubcomponents('vevent').find((event: any) =>
      String(event.getFirstPropertyValue('recurrence-id') ?? '') === String(incoming.getFirstPropertyValue('recurrence-id') ?? ''));
    if (!target || (existing && (Number(target.getFirstPropertyValue('sequence') ?? 0) !== Number(incoming.getFirstPropertyValue('sequence') ?? 0)
      || target.getFirstProperty('dtstart')?.toICALString() !== incoming.getFirstProperty('dtstart')?.toICALString()
      || target.getFirstProperty('dtend')?.toICALString() !== incoming.getFirstProperty('dtend')?.toICALString()))) {
      throw new Error(t('invitation.calendarConflict'));
    }
    let attendee = target.getAllProperties('attendee').find((property: any) => email(property.getFirstValue()) === email(selfEmail));
    if (!attendee) {
      // The receiving mailbox can be an alias of the calendar account.
      attendee = recipientEmail && email(recipientEmail) !== email(target.getFirstPropertyValue('organizer'))
        ? target.getAllProperties('attendee').find((property: any) => email(property.getFirstValue()) === email(recipientEmail))
        : undefined;
      if (attendee) attendee.setValue(`mailto:${email(selfEmail)}`);
      else {
        attendee = new ICAL.Property('attendee');
        attendee.setValue(`mailto:${email(selfEmail)}`);
        target.addProperty(attendee);
      }
    }
    attendee.setParameter('partstat', status);
    attendee.removeParameter('rsvp');
    return target;
  });
  if (existing && (!existing.etag || existing.etag.startsWith('W/'))) throw new Error(t('invitation.calendarConflict'));
  if (published) {
    // PUBLISH is a calendar copy, not an RSVP request (RFC 6638 section 3.2.2.2).
    for (const event of current.getAllSubcomponents('vevent')) {
      for (const property of [...event.getAllProperties('organizer'), ...event.getAllProperties('attendee')]) {
        property.setParameter('schedule-agent', 'NONE');
      }
    }
  }
  current.removeAllProperties('method');
  const url = existing?.url ?? `${cal.url.replace(/\/$/, '')}/${encodeURIComponent(uid)}.ics`;
  try {
    await calendarApi.putCalDav({ ...credentials, url }, current.toString(), existing?.etag, !existing);
  } catch (error) {
    // A lost response or concurrent import may follow a successful write; read before retrying.
    const remote = await lookup().catch(() => undefined);
    const confirmed = remote && targets.every((target: any) => remote.component.getAllSubcomponents('vevent').some((event: any) =>
      String(event.getFirstPropertyValue('recurrence-id') ?? '') === String(target.getFirstPropertyValue('recurrence-id') ?? '')
      && Number(event.getFirstPropertyValue('sequence') ?? 0) === Number(target.getFirstPropertyValue('sequence') ?? 0)
      && event.getFirstProperty('dtstart')?.toICALString() === target.getFirstProperty('dtstart')?.toICALString()
      && event.getFirstProperty('dtend')?.toICALString() === target.getFirstProperty('dtend')?.toICALString()
      && event.getAllProperties('attendee').some((attendee: any) => email(attendee.getFirstValue()) === email(selfEmail)
        && attendee.getParameter('partstat') === status)));
    if (!confirmed) throw error;
  }
}
