// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import EventCreationStatus from './EventCreationStatus';
import i18n from '../../../i18n';
import type { CreationState } from '../hooks/useEventCreation';

it.each(['fr', 'en'])('announces creation states and only offers safe actions (%s)', async language => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const old = i18n.language;
  await i18n.changeLanguage(language);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const retry = vi.fn(); const check = vi.fn(); const dismiss = vi.fn();
  try {
    for (const state of ['saving', 'checking', 'saved', 'refreshFailed', 'failed', 'uncertain'] as CreationState[]) {
      await act(async () => root.render(<EventCreationStatus operations={[{ id: 'op', state, payload: { calendarId: 'cal', title: 'Planning', start: '', end: '', isAllday: false } }]}
        onRetry={retry} onRecheck={check} onDismiss={dismiss} />));
      expect(host.querySelector('[role]')?.getAttribute('role')).toBe(['failed', 'uncertain'].includes(state) ? 'alert' : 'status');
      expect(host.textContent).toContain('Planning');
      expect(host.textContent).not.toContain('createEvent.background');
      expect(host.textContent).not.toContain('event.close');
      const primary = host.querySelector<HTMLButtonElement>('.btn-primary');
      expect(!!primary).toBe(['failed', 'uncertain', 'refreshFailed'].includes(state));
      if (primary) await act(async () => primary.click());
    }
    expect(retry).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledWith('op');
    expect(check).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenCalledWith('op');
  } finally { await act(async () => root.unmount()); host.remove(); await i18n.changeLanguage(old); }
});
