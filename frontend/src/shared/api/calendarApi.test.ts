import { afterEach, describe, expect, it, vi } from 'vitest';
import { calendarApi } from './calendarApi';

describe('calendarApi', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps the generic ICS endpoint response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: 'BEGIN:VCALENDAR' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(calendarApi.fetchIcs('https://calendar.example/feed.ics')).resolves.toBe('BEGIN:VCALENDAR');
    expect(fetchMock).toHaveBeenCalledWith('/api/calendar/ics/fetch', expect.objectContaining({ method: 'POST' }));
  });

  it('surfaces structured backend errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'provider_host_not_allowed' }), { status: 403 })));
    await expect(calendarApi.fetchIcs('https://attacker.example/feed.ics')).rejects.toThrow('provider_host_not_allowed');
  });

  it('preserves conditional feed validators and a not-modified result', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ notModified: true, etag: '"v1"' })));
    vi.stubGlobal('fetch', fetch);
    await expect(calendarApi.fetchIcsResource('https://calendar.example/feed', '"v1"', 'yesterday')).resolves.toEqual({ notModified: true, etag: '"v1"' });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ url: 'https://calendar.example/feed', etag: '"v1"', lastModified: 'yesterday' });
  });
});

it('passes create-only protection to the web CalDAV adapter', async () => {
  const request = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', request);
  try {
    await calendarApi.putCalDav({ url: 'https://cloud.test/event.ics', username: 'me', password: 'test' }, 'ICS', undefined, true);
    expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({ ifNoneMatch: true });
  } finally { vi.unstubAllGlobals(); }
});
