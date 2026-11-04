import { afterEach, expect, it, vi } from 'vitest';
import { queryRoomAvailability } from './roomAvailability';
import { exchangeCalendarApi } from '../../../shared/api/exchangeCalendarApi';
import { queryFreeBusy } from './googleCalendarApi';
import type { CalendarConfig } from '../../../shared/types';

vi.mock('../../../shared/api/exchangeCalendarApi', () => ({ exchangeCalendarApi: { freeBusy: vi.fn() } }));
vi.mock('./googleCalendarApi', () => ({ queryFreeBusy: vi.fn() }));
const cal: CalendarConfig = { id: 'cal', type: 'exchange', exchangeAccountId: 'ews', googleAccountId: 'google', url: '', color: '', name: '', visible: true };
const start = new Date('2026-10-27T10:00:00Z'), end = new Date('2026-10-27T11:00:00Z');
const auth = { getExchangeRefreshToken: vi.fn(() => 'secret'), getValidToken: vi.fn().mockResolvedValue('token') };
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

it('checks actual overlap and distinguishes busy, tentative, free, inaccessible and missing EWS results', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(exchangeCalendarApi.freeBusy).mockImplementation(async request => {
    const email = (request.emails as string[])[0];
    if (email === 'denied') throw new Error('secret upstream details');
    if (email === 'missing') return {};
    const slots = email === 'free' ? [{ start: '2026-10-27T09:00:00Z', end: '2026-10-27T10:00:00Z', busy_type: 'Busy' }]
      : [{ start: '2026-10-27T10:30:00Z', end: '2026-10-27T11:30:00Z', busy_type: email === 'tentative' ? 'Tentative' : 'Busy' }];
    return { [email]: slots } as never;
  });
  expect(await queryRoomAvailability(cal, ['busy', 'free', 'tentative', 'denied', 'missing'], start, end, auth))
    .toEqual({ busy: 'busy', free: 'free', tentative: 'tentative', denied: 'unknown', missing: 'unknown' });
  expect(exchangeCalendarApi.freeBusy).toHaveBeenCalledWith(expect.objectContaining({ start: '2026-10-27T10:00:00', end: '2026-10-27T11:00:00' }));
  expect(warn).toHaveBeenCalledOnce();
  expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
});

it('never interprets missing, malformed or unknown EWS slot data as free', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (const value of [undefined, [{ start: start.toISOString(), end: end.toISOString(), busy_type: 'NoData' }], [{ start: 'invalid', end: end.toISOString(), busy_type: 'Busy' }]]) {
    vi.mocked(exchangeCalendarApi.freeBusy).mockResolvedValue({ room: value });
    expect(await queryRoomAvailability(cal, ['room'], start, end, auth)).toEqual({ room: 'unknown' });
  }
});

it('uses Google free/busy without treating denied resources as available', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  auth.getValidToken.mockResolvedValue('token');
  vi.mocked(queryFreeBusy).mockResolvedValue({
    busy: { busy: [{ start, end }], unavailable: false },
    free: { busy: [], unavailable: false },
    denied: { busy: [], unavailable: true },
  });
  expect(await queryRoomAvailability({ ...cal, type: 'google' }, ['busy', 'free', 'denied'], start, end, auth)).toEqual({ busy: 'busy', free: 'free', denied: 'unknown' });
});

it('leaves unsupported CalDAV availability and invalid ranges unknown without remote requests', async () => {
  expect(await queryRoomAvailability({ ...cal, type: 'nextcloud' }, ['room'], start, end, auth)).toEqual({ room: 'unknown' });
  expect(await queryRoomAvailability(cal, ['room'], end, start, auth)).toEqual({ room: 'unknown' });
  expect(exchangeCalendarApi.freeBusy).not.toHaveBeenCalled();
  expect(queryFreeBusy).not.toHaveBeenCalled();
});
