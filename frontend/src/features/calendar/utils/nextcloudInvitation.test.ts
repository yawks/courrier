// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { t } from 'i18next';
import '../../../i18n';
// @ts-ignore – ical.js v1 has no bundled types
import ICAL from 'ical.js';
import { calendarApi } from '../../../shared/api/calendarApi';
import { respondToNextcloudInvitation } from './nextcloudInvitation';
import type { CalendarConfig } from '../../../shared/types';
vi.mock('../../../shared/api/calendarApi', () => ({ calendarApi: { queryCalDav: vi.fn(), putCalDav: vi.fn() } }));
const cal = { id: 'nc', type: 'nextcloud', url: 'https://cloud.test/calendars/me/personal/', ownerEmail: 'me@example.test' } as CalendarConfig;
const invitation = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:original-id', 'SEQUENCE:2', 'DTSTART:20261119T120000Z', 'DTEND:20261119T130000Z', 'SUMMARY:Invitation', 'ORGANIZER:mailto:organizer@example.test', 'ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:me@example.test', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:other@example.test', 'RRULE:FREQ=WEEKLY;COUNT=4', 'X-CUSTOM:keep', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
const response = (ics?: string, href = '/calendars/me/personal/server-name.ics') => `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${ics ? `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>"v1"</d:getetag><c:calendar-data><![CDATA[${ics}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` : ''}</d:multistatus>`;
beforeEach(() => { vi.resetAllMocks(); vi.mocked(calendarApi.queryCalDav).mockResolvedValue(response()); });
it.each(['ACCEPTED', 'DECLINED', 'TENTATIVE'] as const)('imports the actual invitation with %s and create-only protection', async status => {
  await respondToNextcloudInvitation(cal, invitation, 'ME@example.test', status);
  const [credentials, text, etag, createOnly] = vi.mocked(calendarApi.putCalDav).mock.calls[0];
  expect(credentials.url).toMatch(/^https:\/\/cloud.test\/calendars\/me\/personal\/.+\.ics$/);
  expect(etag).toBeUndefined(); expect(createOnly).toBe(true);
  const comp = new ICAL.Component(ICAL.parse(text));
  expect(comp.hasProperty('method')).toBe(false);
  const event = comp.getFirstSubcomponent('vevent');
  expect(event.getFirstPropertyValue('uid')).toBe('original-id');
  expect(event.getFirstPropertyValue('organizer')).toBe('mailto:organizer@example.test');
  expect(event.getFirstPropertyValue('x-custom')).toBe('keep');
  expect(event.getFirstPropertyValue('rrule').toString()).toBe('FREQ=WEEKLY;COUNT=4');
  const attendees = event.getAllProperties('attendee');
  expect(attendees[0].getParameter('partstat')).toBe(status);
  expect(attendees[0].getParameter('rsvp')).toBeUndefined();
  expect(attendees[1].getParameter('partstat')).toBe('ACCEPTED');
});
it('finds an existing UID and uses its server URL and ETag without duplicating it', async () => {
  vi.mocked(calendarApi.queryCalDav).mockResolvedValue(response(invitation));
  await respondToNextcloudInvitation(cal, invitation, cal.ownerEmail!, 'ACCEPTED');
  expect(calendarApi.putCalDav).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://cloud.test/calendars/me/personal/server-name.ics' }), expect.any(String), '"v1"', false);
});
it('rejects a changed remote schedule without overwriting it', async () => {
  vi.mocked(calendarApi.queryCalDav).mockResolvedValue(response(invitation.replace('SEQUENCE:2', 'SEQUENCE:3')));
  await expect(respondToNextcloudInvitation(cal, invitation, cal.ownerEmail!, 'ACCEPTED')).rejects.toThrow();
  expect(calendarApi.putCalDav).not.toHaveBeenCalled();
});
it.each([
  invitation.replace('METHOD:REQUEST', 'METHOD:CANCEL'),
  invitation.replace('ORGANIZER:mailto:organizer@example.test\r\n', ''),
])('rejects invalid invitations before making requests', async text => {
  await expect(respondToNextcloudInvitation(cal, text, cal.ownerEmail!, 'ACCEPTED')).rejects.toThrow();
  expect(calendarApi.queryCalDav).not.toHaveBeenCalled(); expect(calendarApi.putCalDav).not.toHaveBeenCalled();
});
it('never sends credentials to an origin supplied by the REPORT response', async () => {
  vi.mocked(calendarApi.queryCalDav).mockResolvedValue(response(invitation, 'https://other.test/event.ics'));
  await expect(respondToNextcloudInvitation(cal, invitation, cal.ownerEmail!, 'ACCEPTED')).rejects.toThrow();
  expect(calendarApi.putCalDav).not.toHaveBeenCalled();
});
it('confirms an uncertain write by reading back the attendee response', async () => {
  vi.mocked(calendarApi.queryCalDav).mockResolvedValueOnce(response()).mockResolvedValueOnce(response(invitation.replace('PARTSTAT=NEEDS-ACTION', 'PARTSTAT=ACCEPTED')));
  vi.mocked(calendarApi.putCalDav).mockRejectedValueOnce(new Error('connection lost'));
  await expect(respondToNextcloudInvitation(cal, invitation, cal.ownerEmail!, 'ACCEPTED')).resolves.toBeUndefined();
  expect(calendarApi.putCalDav).toHaveBeenCalledTimes(1);
});
it('reports failed writes without retrying or announcing success', async () => {
  vi.mocked(calendarApi.putCalDav).mockRejectedValueOnce(new Error('offline'));
  await expect(respondToNextcloudInvitation(cal, invitation, cal.ownerEmail!, 'ACCEPTED')).rejects.toThrow('offline');
  expect(calendarApi.putCalDav).toHaveBeenCalledTimes(1);
});
it('does not import into shared or read-only calendars', async () => {
  await expect(respondToNextcloudInvitation({ ...cal, readOnly: true }, invitation, cal.ownerEmail!, 'ACCEPTED')).rejects.toThrow();
  expect(calendarApi.queryCalDav).not.toHaveBeenCalled();
});

it('preserves time zone components and recurrence exceptions from the mail', async () => {
  const zone = 'BEGIN:VTIMEZONE\r\nTZID:Europe/Paris\r\nBEGIN:STANDARD\r\nDTSTART:19701025T030000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n';
  const exception = 'BEGIN:VEVENT\r\nUID:original-id\r\nRECURRENCE-ID:20261126T120000Z\r\nDTSTART:20261126T140000Z\r\nDTEND:20261126T150000Z\r\nORGANIZER:mailto:organizer@example.test\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.test\r\nEND:VEVENT\r\n';
  const text = invitation.replace('BEGIN:VEVENT', zone + 'BEGIN:VEVENT').replace('END:VCALENDAR', exception + 'END:VCALENDAR');
  await respondToNextcloudInvitation(cal, text, cal.ownerEmail!, 'ACCEPTED');
  const saved = new ICAL.Component(ICAL.parse(vi.mocked(calendarApi.putCalDav).mock.calls[0][1]));
  expect(saved.getFirstSubcomponent('vtimezone').getFirstPropertyValue('tzid')).toBe('Europe/Paris');
  const events = saved.getAllSubcomponents('vevent');
  expect(events).toHaveLength(2);
  expect(events[1].getFirstPropertyValue('recurrence-id').toString()).toBe('2026-11-26T12:00:00Z');
  for (const event of events) expect(event.getFirstProperty('attendee').getParameter('partstat')).toBe('ACCEPTED');
});

it.each(['ACCEPTED', 'DECLINED', 'TENTATIVE'] as const)('responds as the calendar account when mail was sent to an alias: %s', async status => {
  const text = invitation.replace('mailto:me@example.test', 'mailto:alias@example.test');
  await respondToNextcloudInvitation(cal, text, cal.ownerEmail!, status, 'ALIAS@example.test');
  const event = new ICAL.Component(ICAL.parse(vi.mocked(calendarApi.putCalDav).mock.calls[0][1])).getFirstSubcomponent('vevent');
  const attendees = event.getAllProperties('attendee');
  expect(attendees).toHaveLength(2);
  expect(attendees[0].getFirstValue()).toBe('mailto:me@example.test');
  expect(attendees[0].getParameter('partstat')).toBe(status);
  expect(attendees[1].getFirstValue()).toBe('mailto:other@example.test');
  expect(attendees[1].getParameter('partstat')).toBe('ACCEPTED');
  expect(event.getFirstPropertyValue('organizer')).toBe('mailto:organizer@example.test');
  expect(event.getFirstPropertyValue('uid')).toBe('original-id');
});
it('adds the calendar account without guessing which other guest to replace', async () => {
  const text = invitation.replace('mailto:me@example.test', 'mailto:someone@example.test');
  await respondToNextcloudInvitation(cal, text, cal.ownerEmail!, 'ACCEPTED', 'alias@example.test');
  const event = new ICAL.Component(ICAL.parse(vi.mocked(calendarApi.putCalDav).mock.calls[0][1])).getFirstSubcomponent('vevent');
  expect(event.getAllProperties('attendee').map((a: any) => a.getFirstValue())).toEqual(['mailto:someone@example.test', 'mailto:other@example.test', 'mailto:me@example.test']);
});
it('keeps the existing calendar attendee without duplicating it when an alias is supplied', async () => {
  await respondToNextcloudInvitation(cal, invitation, cal.ownerEmail!, 'ACCEPTED', 'alias@example.test');
  const event = new ICAL.Component(ICAL.parse(vi.mocked(calendarApi.putCalDav).mock.calls[0][1])).getFirstSubcomponent('vevent');
  expect(event.getAllProperties('attendee')).toHaveLength(2);
});

it('accepts a received calendar file without METHOD when the organizer is present', async () => {
  await respondToNextcloudInvitation(cal, invitation.replace('METHOD:REQUEST\r\n', ''), cal.ownerEmail!, 'ACCEPTED');
  expect(calendarApi.putCalDav).toHaveBeenCalledTimes(1);
});
it.each([
  [invitation, '', 'calendarEmailMissing'],
  [invitation.replace('ORGANIZER:mailto:organizer@example.test\r\n', ''), cal.ownerEmail!, 'organizerMissing'],
  [invitation.replace('ORGANIZER:mailto:organizer@example.test', 'ORGANIZER:mailto:me@example.test'), cal.ownerEmail!, 'organizerIsAccount'],
  [invitation.replace('UID:original-id\r\n', ''), cal.ownerEmail!, 'missingUid'],
])('reports the actual validation failure without sending a request', async (text, address, key) => {
  await expect(respondToNextcloudInvitation(cal, text, address, 'ACCEPTED')).rejects.toThrow(t(`invitation.${key}`));
  expect(calendarApi.queryCalDav).not.toHaveBeenCalled();
  expect(calendarApi.putCalDav).not.toHaveBeenCalled();
});

it.each(['ACCEPTED', 'DECLINED', 'TENTATIVE'] as const)('imports PUBLISH appointments with %s without requesting scheduling delivery', async status => {
  const text = invitation.replace('METHOD:REQUEST', 'METHOD:PUBLISH');
  await respondToNextcloudInvitation(cal, text, cal.ownerEmail!, status);
  const component = new ICAL.Component(ICAL.parse(vi.mocked(calendarApi.putCalDav).mock.calls[0][1]));
  expect(component.hasProperty('method')).toBe(false);
  const event = component.getFirstSubcomponent('vevent');
  expect(event.getFirstPropertyValue('uid')).toBe('original-id');
  expect(event.getFirstPropertyValue('organizer')).toBe('mailto:organizer@example.test');
  expect(event.getFirstProperty('organizer').getParameter('schedule-agent')).toBe('NONE');
  const attendees = event.getAllProperties('attendee');
  expect(attendees[0].getParameter('partstat')).toBe(status);
  for (const attendee of attendees) expect(attendee.getParameter('schedule-agent')).toBe('NONE');
});
it('imports PUBLISH without an organizer and adds the calendar account', async () => {
  const text = invitation.replace('METHOD:REQUEST', 'METHOD:PUBLISH').replace('ORGANIZER:mailto:organizer@example.test\r\n', '').replace('ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:me@example.test\r\n', '');
  await respondToNextcloudInvitation(cal, text, cal.ownerEmail!, 'ACCEPTED');
  const event = new ICAL.Component(ICAL.parse(vi.mocked(calendarApi.putCalDav).mock.calls[0][1])).getFirstSubcomponent('vevent');
  expect(event.hasProperty('organizer')).toBe(false);
  expect(event.getAllProperties('attendee').find((attendee: any) => attendee.getFirstValue() === 'mailto:me@example.test').getParameter('partstat')).toBe('ACCEPTED');
});
it('keeps scheduling enabled for real REQUEST invitations', async () => {
  await respondToNextcloudInvitation(cal, invitation, cal.ownerEmail!, 'ACCEPTED');
  const event = new ICAL.Component(ICAL.parse(vi.mocked(calendarApi.putCalDav).mock.calls[0][1])).getFirstSubcomponent('vevent');
  expect(event.getFirstProperty('organizer').getParameter('schedule-agent')).toBeUndefined();
});
it.each(['REPLY', 'CANCEL', 'COUNTER'])('reports the unsupported method %s without sending requests', async method => {
  await expect(respondToNextcloudInvitation(cal, invitation.replace('METHOD:REQUEST', `METHOD:${method}`), cal.ownerEmail!, 'ACCEPTED')).rejects.toThrow(t('invitation.unsupportedMethod', { method }));
  expect(calendarApi.queryCalDav).not.toHaveBeenCalled();
  expect(calendarApi.putCalDav).not.toHaveBeenCalled();
});
