// @vitest-environment jsdom
import { act, forwardRef, useImperativeHandle } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CreateEventModal from './CreateEventModal';
import { invokeNative } from '../../../shared/api/nativeTransport';
import type { CalendarConfig } from '../../../shared/types';
import '../../../i18n';

vi.mock('../../../shared/api/nativeTransport', () => ({ hasNativeTransport: () => true, invokeNative: vi.fn() }));
vi.mock('../store/TagStore', () => ({ useTags: () => ({ tags: [], eventTags: {} }) }));
vi.mock('../../mail/components/MailEditor', () => ({ MailEditor: forwardRef((_props, ref) => {
  useImperativeHandle(ref, () => ({ getHTML: () => '' }));
  return <div data-testid="mail-editor" />;
}) }));

const calendar: CalendarConfig = { id: 'ews', type: 'exchange', exchangeAccountId: 'account', name: 'Exchange', color: '#888', visible: true, url: '' };
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true, value: function (this: HTMLDialogElement) { this.open = true; },
  });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); vi.restoreAllMocks(); vi.clearAllMocks(); });

it.each(['rooms', 'empty', 'failure', 'typing'])('triggers the EWS native command from the actual event form (%s)', async result => {
  const getExchangeToken = vi.fn().mockResolvedValue('test-token');
  if (result === 'failure') vi.mocked(invokeNative).mockRejectedValueOnce('ews_room_discovery_failed');
  else vi.mocked(invokeNative).mockResolvedValueOnce(['rooms', 'typing'].includes(result) ? [{ name: 'Conference room', email: 'room@example.test' }] : []);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<CreateEventModal
      initialStart="2026-10-27T10:00:00Z" initialEnd="2026-10-27T11:00:00Z"
      writableCalendars={[calendar]} allEvents={[]}
      onSubmit={vi.fn()} onClose={vi.fn()} getExchangeToken={getExchangeToken}
    />));
    expect(invokeNative).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith('[Room discovery] location autocomplete ready', expect.objectContaining({ provider: 'exchange' }));
    const input = host.querySelector<HTMLInputElement>('#ev-location')!;
    await act(async () => {
      if (result === 'typing') {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Conference');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else input.focus();
    });
    expect(getExchangeToken).toHaveBeenCalledWith('account');
    expect(invokeNative).toHaveBeenCalledWith('exchange_calendar_rooms', { accessToken: 'test-token' });
    expect(input.getAttribute('aria-busy')).toBe(result === 'typing' ? 'true' : 'false');
    if (['rooms', 'typing'].includes(result)) {
      expect(host.querySelector('[role="option"]')?.textContent).toContain('Conference room');
      expect(console.warn).not.toHaveBeenCalled();
    } else {
      expect(host.querySelector('[role="listbox"]')).toBeNull();
      expect(console.warn).toHaveBeenCalledOnce();
      expect(host.querySelector('[role="alert"]')).toBeNull();
    }
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('test-token');
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('test-token');
  } finally { await act(async () => root.unmount()); host.remove(); }
});
