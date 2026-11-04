import type { CalendarConfig } from '../../../shared/types';
import { exchangeCalendarApi } from '../../../shared/api/exchangeCalendarApi';
import { queryFreeBusy } from './googleCalendarApi';
import type { RoomDiscoveryAuth } from './roomDiscovery';

export type RoomAvailability = 'free' | 'busy' | 'tentative' | 'unknown';
export interface RoomAvailabilityAuth extends RoomDiscoveryAuth {
  getExchangeRefreshToken?: (accountId: string) => string | null;
}

const overlaps = (from: string | Date, to: string | Date, start: Date, end: Date) => {
  const a = new Date(from).getTime(), b = new Date(to).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) throw new Error('invalid_availability_slot');
  return a < end.getTime() && b > start.getTime();
};

/** Failed or incomplete availability must never be represented as a free room. */
export async function queryRoomAvailability(
  cal: CalendarConfig, emails: string[], start: Date, end: Date, auth: RoomAvailabilityAuth,
): Promise<Record<string, RoomAvailability>> {
  const addresses = [...new Set(emails.map(email => email.toLowerCase()))];
  const result = Object.fromEntries(addresses.map(email => [email, 'unknown' as RoomAvailability]));
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start || !addresses.length) return result;
  const warning = () => console.warn(`[Room availability] ${cal.type} availability unavailable; keeping location editable.`);
  try {
    if (cal.type === 'exchange') {
      const refreshToken = cal.exchangeAccountId && auth.getExchangeRefreshToken?.(cal.exchangeAccountId);
      if (!refreshToken) throw new Error('room_auth_unavailable');
      const utc = (value: Date) => value.toISOString().slice(0, 19);
      // Isolate permission errors: one inaccessible resource must not hide all
      // other results. Bound concurrency and use the shared EWS throttle budget.
      let index = 0;
      let failed = false;
      await Promise.all(Array.from({ length: Math.min(3, addresses.length) }, async () => {
        while (index < addresses.length) {
          const email = addresses[index++];
          try {
            const data = await exchangeCalendarApi.freeBusy<Record<string, Array<{ start: string; end: string; busy_type: string }>>>({
              refreshToken, emails: [email], start: utc(start), end: utc(end), anchorMailbox: cal.ownerEmail,
            });
            const slots = data[email];
            if (!Array.isArray(slots)) throw new Error('missing_availability');
            let state: RoomAvailability = 'free';
            for (const slot of slots) {
              if (!['Free', 'Busy', 'Tentative', 'OOF', 'WorkingElsewhere'].includes(slot.busy_type)) throw new Error('unknown_availability');
              if (!overlaps(slot.start, slot.end, start, end)) continue;
              if (['Busy', 'OOF', 'WorkingElsewhere'].includes(slot.busy_type)) state = 'busy';
              else if (slot.busy_type === 'Tentative' && state !== 'busy') state = 'tentative';
            }
            result[email] = state;
          } catch { failed = true; }
        }
      }));
      if (failed) warning();
    } else if (cal.type === 'google') {
      const token = cal.googleAccountId && await auth.getValidToken?.(cal.googleAccountId);
      if (!token) throw new Error('room_auth_unavailable');
      const data = await queryFreeBusy(token, addresses, start, end);
      let failed = false;
      for (const email of addresses) {
        const entry = data[email];
        if (!entry || entry.unavailable) { failed = true; continue; }
        result[email] = entry.busy.some(slot => overlaps(slot.start, slot.end, start, end)) ? 'busy' : 'free';
      }
      if (failed) warning();
    }
    // CalDAV resource principals do not guarantee an accessible free/busy
    // endpoint. Until scheduling discovery is supported, retain "unknown".
  } catch { warning(); }
  return result;
}
