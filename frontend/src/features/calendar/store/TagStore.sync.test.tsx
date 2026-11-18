// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TagProvider, useTags } from './TagStore';

const data = vi.hoisted(() => ({
  payload: {} as Record<string, unknown>, enabled: true, sync: vi.fn(),
}));
vi.mock('../../../shared/security/VaultProvider', () => ({ useVault: () => ({
  read: (key: string, fallback: unknown) => data.payload[key] ?? fallback,
  write: (key: string, value: unknown) => { data.payload[key] = value; },
  syncCalendarTags: data.sync,
  configSyncSettings: data.enabled ? { enabled: true, serverUrl: 'https://cloud.example', username: 'fixture' } : null,
}) }));
vi.mock('../utils/eventCache', () => ({ cacheGetStale: async () => null, cacheSet: async () => {} }));

let value: ReturnType<typeof useTags>;
let root: ReturnType<typeof createRoot>;
function Probe() { value = useTags(); return null; }
const snapshot = () => ({
  'calendar-desktop-tags': data.payload['calendar-desktop-tags'],
  'calendar-event-tags': data.payload['calendar-event-tags'],
  needsUpload: false,
});
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const mount = async () => { await act(async () => root.render(<TagProvider><Probe /></TagProvider>)); };
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  data.enabled = true;
  data.payload = {
    'calendar-desktop-tags': [{ id: 'focus', name: 'Focus', color: '#123456' }],
    'calendar-event-tags': {},
  };
  data.sync.mockReset().mockImplementation(async () => snapshot());
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});

it('synchronizes existing unsent tagging after opening, without an upload loop', async () => {
  await mount();
  await advance(1500);
  expect(data.sync).toHaveBeenCalledOnce();
  await advance(10000);
  expect(data.sync).toHaveBeenCalledOnce();
});

it('groups consecutive tagging into one automatic synchronization after the last edit', async () => {
  await mount();
  await advance(1500);
  data.sync.mockClear();
  await act(async () => value.setEventTag('first', 'focus'));
  await advance(1000);
  await act(async () => value.setEventTag('second', 'focus'));
  await advance(1499);
  expect(data.sync).not.toHaveBeenCalled();
  await advance(1);
  expect(data.sync).toHaveBeenCalledOnce();
  expect(data.payload['calendar-event-tags']).toEqual({ first: 'focus', second: 'focus' });
});

it('automatically synchronizes definition edits and association removals as one batch', async () => {
  await mount();
  await advance(1500);
  data.sync.mockClear();
  await act(async () => {
    value.updateTag('focus', { name: 'Renamed' });
    value.setEventTag('event', 'focus');
  });
  await act(async () => value.removeEventTag('event'));
  await advance(1500);
  expect(data.sync).toHaveBeenCalledOnce();
  expect(value.tags[0].name).toBe('Renamed');
  expect(value.eventTags).toEqual({});
});

it('does not schedule an automatic upload when configuration synchronization is disabled', async () => {
  data.enabled = false;
  await mount();
  await act(async () => value.setEventTag('event', 'focus'));
  await advance(5000);
  expect(data.sync).not.toHaveBeenCalled();
  expect(value.eventTags).toEqual({ event: 'focus' });
});

it('keeps a failed batch and retries it when connectivity returns', async () => {
  data.sync.mockRejectedValueOnce(new Error('offline'));
  await mount();
  await act(async () => value.setEventTag('event', 'focus'));
  await advance(1500);
  expect(data.sync).toHaveBeenCalledOnce();
  expect(value.eventTags).toEqual({ event: 'focus' });
  await act(async () => { globalThis.dispatchEvent(new Event('online')); });
  await advance(1500);
  expect(data.sync).toHaveBeenCalledTimes(2);
  expect(value.eventTags).toEqual({ event: 'focus' });
});

it('coalesces a manual calendar refresh and the pending automatic batch', async () => {
  let finish!: (result: ReturnType<typeof snapshot>) => void;
  data.sync.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await mount();
  let first!: Promise<void>;
  let second!: Promise<void>;
  await act(async () => {
    first = value.refreshTags();
    second = value.refreshTags();
  });
  expect(first).toBe(second);
  expect(value.isSynchronizing).toBe(true);
  await advance(5000);
  expect(data.sync).toHaveBeenCalledOnce();
  await act(async () => { finish(snapshot()); await first; });
  expect(value.isSynchronizing).toBe(false);
});

it('schedules another batch for edits preserved while the previous upload was in flight', async () => {
  data.sync.mockImplementationOnce(async () => ({ ...snapshot(), needsUpload: true }));
  await mount();
  await advance(1500);
  expect(data.sync).toHaveBeenCalledOnce();
  await advance(1500);
  expect(data.sync).toHaveBeenCalledTimes(2);
  await advance(5000);
  expect(data.sync).toHaveBeenCalledTimes(2);
});
