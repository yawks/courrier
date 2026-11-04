// @vitest-environment jsdom
import { act, forwardRef, useImperativeHandle, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useEventCreation } from './useEventCreation';
import CreateEventModal from '../components/CreateEventModal';
import type { CalendarConfig, CalendarEvent, CreateEventPayload } from '../../../shared/types';
import '../../../i18n';

vi.mock('../store/TagStore', () => ({ useTags: () => ({ tags: [], eventTags: {} }) }));
vi.mock('../../mail/components/MailEditor', () => ({ MailEditor: forwardRef((_props, ref) => {
  useImperativeHandle(ref, () => ({ getHTML: () => '' }));
  return <div />;
}) }));

const payload: CreateEventPayload = {
  calendarId: 'cal', title: 'Planning', start: '2026-11-10T10:00:00Z', end: '2026-11-10T11:00:00Z', isAllday: false,
  attendees: [{ email: 'guest@example.test', name: 'Camille', optional: true }],
};
const saved: CalendarEvent = {
  ...payload, tagId: undefined, id: 'cal::saved', sourceId: 'saved|new-key', category: 'time',
  attendees: [{ email: 'guest@example.test', name: 'Camille', optional: true, status: 'NEEDS-ACTION' }],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let creation: ReturnType<typeof useEventCreation>;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function () { this.open = true; } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
function Harness({ events }: { events: CalendarEvent[] }) { creation = useEventCreation(events); return null; }
async function render(events: CalendarEvent[] = []) {
  await act(async () => root.render(<Harness events={events} />));
}

it('shows optional attendees immediately, reconciles by ID, and never resurrects a deleted event', async () => {
  const save = deferred<string>();
  const remote = deferred<CalendarEvent[]>();
  const refresh = vi.fn(() => remote.promise);
  const confirmed = vi.fn();
  await render();
  await act(async () => creation.begin(payload, () => save.promise, refresh, confirmed));
  expect(creation.created[0].attendees).toEqual(saved.attendees);
  expect(creation.operations[0].state).toBe('saving');
  expect(confirmed).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  await act(async () => save.resolve('saved'));
  expect(creation.operations[0].state).toBe('saved');
  expect(creation.created[0].sourceId).toBe('saved');
  await act(async () => remote.resolve([saved]));
  await render([saved]);
  expect(creation.created).toHaveLength(0);
  await render([]);
  expect(creation.created).toHaveLength(0);
});

it('does not hide a new creation behind an unrelated event with identical title and time', async () => {
  await render([{ ...saved, sourceId: 'other|key', id: 'other' }]);
  await act(async () => creation.begin(payload, () => new Promise(() => {}), vi.fn(), vi.fn()));
  expect(creation.created).toHaveLength(1);
});

it('rolls back only the failed creation, exposes retry, and prevents duplicate submission', async () => {
  const request = deferred<string>();
  const save = vi.fn(() => request.promise);
  await render();
  await act(async () => {
    creation.begin(payload, save, vi.fn(), vi.fn());
    creation.begin(payload, save, vi.fn(), vi.fn());
    creation.begin({ ...payload, title: 'Another' }, () => new Promise(() => {}), vi.fn(), vi.fn());
  });
  expect(save).toHaveBeenCalledTimes(1);
  await act(async () => request.reject(new Error('ErrorAccessDenied')));
  expect(creation.created.map(ev => ev.title)).toEqual(['Another']);
  expect(creation.operations[0].state).toBe('failed');
  await act(async () => creation.retry(creation.operations[0].id));
  expect(save).toHaveBeenCalledTimes(2);
});

it('retains a confirmed event after refresh failure without retrying its creation', async () => {
  const save = vi.fn().mockResolvedValue('saved');
  const confirmed = vi.fn();
  await render();
  await act(async () => creation.begin(payload, save, vi.fn().mockRejectedValue(new Error('offline')), confirmed));
  expect(creation.operations[0].state).toBe('refreshFailed');
  expect(creation.created).toHaveLength(1);
  expect(confirmed).toHaveBeenCalledOnce();
  await act(async () => creation.retry(creation.operations[0].id));
  expect(save).toHaveBeenCalledOnce();
});

it('rereads after an uncertain write and confirms the remote result instead of sending again', async () => {
  const save = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
  const refresh = vi.fn().mockResolvedValue([saved]);
  await render();
  await act(async () => creation.begin(payload, save, refresh, vi.fn()));
  expect(creation.operations[0].state).toBe('saved');
  expect(creation.created[0].sourceId).toBe('saved');
  expect(save).toHaveBeenCalledOnce();
});

it('keeps an uncertain result provisional, permits only rereading, then reconciles', async () => {
  const save = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
  const refresh = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([saved]);
  await render();
  await act(async () => creation.begin(payload, save, refresh, vi.fn()));
  expect(creation.operations[0].state).toBe('uncertain');
  expect(creation.created).toHaveLength(1);
  await act(async () => creation.retry(creation.operations[0].id));
  expect(save).toHaveBeenCalledOnce();
  await act(async () => creation.recheck(creation.operations[0].id));
  expect(creation.operations[0].state).toBe('saved');
  expect(refresh).toHaveBeenCalledTimes(2);
});

it.each(['google', 'exchange', 'nextcloud'] as const)('closes the actual creation form before the %s request finishes, with optional guests visible', async type => {
  const pending = deferred<string>();
  const save = vi.fn(() => pending.promise);
  const calendar: CalendarConfig = { id: 'cal', name: type, type, url: 'https://calendar.example.test/', visible: true, color: '#888' };
  function Form() {
    const [open, setOpen] = useState(true);
    creation = useEventCreation([]);
    return open ? <CreateEventModal initialStart={payload.start} initialEnd={payload.end} writableCalendars={[calendar]} allEvents={[]}
      onClose={() => setOpen(false)} onSubmit={async p => creation.begin(p, save, vi.fn().mockResolvedValue([]), vi.fn())} /> : null;
  }
  await act(async () => root.render(<Form />));
  async function typeInto(selector: string, text: string) {
    const input = host.querySelector<HTMLInputElement>(selector)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return input;
  }
  await typeInto('#ev-title', payload.title);
  const input = await typeInto('#ev-attendees', 'guest@example.test');
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await act(async () => host.querySelector<HTMLButtonElement>('.attendee-chip-role')!.click());
  await act(async () => {
    const form = host.querySelector('form')!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(host.querySelector('dialog')).toBeNull();
  expect(save).toHaveBeenCalledOnce();
  expect(creation.operations[0].state).toBe('saving');
  expect(creation.created[0].attendees?.[0]).toMatchObject({ email: 'guest@example.test', optional: true });
  await act(async () => pending.resolve('saved'));
});

it('uses the saved ID for a targeted read and unlocks the server snapshot without a calendar reload', async () => {
  const remote = deferred<CalendarEvent[]>();
  const refresh = vi.fn(() => remote.promise);
  await render();
  await act(async () => creation.begin(payload, async () => 'saved', refresh, vi.fn()));
  expect(creation.created[0].readOnly).toBe(true);
  expect(refresh).toHaveBeenCalledWith('saved');
  await act(async () => remote.resolve([saved]));
  expect(creation.created).toEqual([saved]);
  expect(creation.created[0].readOnly).not.toBe(true);
  expect(creation.created[0].sourceId).toBe('saved|new-key');
  await render([saved]);
  expect(creation.created).toHaveLength(0);
});

it('replaces a provisional series by its occurrences without duplicates', async () => {
  const occurrences = [saved, { ...saved, id: 'second', sourceId: 'second|key', start: '2026-11-17T10:00:00Z' }];
  await render();
  await act(async () => creation.begin(payload, async () => 'master', vi.fn().mockResolvedValue(occurrences), vi.fn()));
  expect(creation.created).toEqual(occurrences);
  await render(occurrences);
  expect(creation.created).toHaveLength(0);
});

it('retries only the targeted read after a confirmed creation, and prevents overlapping reads', async () => {
  const retry = deferred<CalendarEvent[]>();
  const save = vi.fn().mockResolvedValue('saved');
  const refresh = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(() => retry.promise);
  await render();
  await act(async () => creation.begin(payload, save, refresh, vi.fn()));
  const id = creation.operations[0].id;
  expect(creation.operations[0].state).toBe('refreshFailed');
  await act(async () => { creation.recheck(id); creation.recheck(id); });
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(refresh).toHaveBeenLastCalledWith('saved');
  await act(async () => retry.resolve([saved]));
  expect(creation.operations[0].state).toBe('saved');
  expect(creation.created).toEqual([saved]);
  expect(save).toHaveBeenCalledOnce();
});
