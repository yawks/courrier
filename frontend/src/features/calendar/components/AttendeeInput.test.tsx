// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import AttendeeInput from './AttendeeInput';
import type { CreateEventPayload } from '../../../shared/types';
import i18n from '../../../i18n';

vi.mock('../../mail/components/ContactAvatar', () => ({ ContactAvatar: () => null }));

it.each(['fr', 'en'])('toggles a guest role without duplication and preserves other guests (%s)', async language => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const previousLanguage = i18n.language;
  await i18n.changeLanguage(language);
  const changed = vi.fn();
  function Form() {
    const [value, setValue] = useState<NonNullable<CreateEventPayload['attendees']>>([
      { email: 'required@example.test' }, { email: 'optional@example.test', optional: true },
    ]);
    return <AttendeeInput value={value} allEvents={[]} onChange={next => { changed(next); setValue(next); }} />;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Form />));
    const buttons = host.querySelectorAll<HTMLButtonElement>('[aria-pressed]');
    expect(buttons[0].textContent).toBe(language === 'fr' ? 'Obligatoire' : 'Required');
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
    await act(async () => buttons[0].click());
    expect(changed).toHaveBeenLastCalledWith([
      { email: 'required@example.test', optional: true }, { email: 'optional@example.test', optional: true },
    ]);
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
    expect(buttons[0].textContent).toBe(language === 'fr' ? 'Optionnel' : 'Optional');
    await act(async () => buttons[0].click());
    expect(changed.mock.lastCall?.[0][0].optional).toBe(false);
    expect(host.querySelectorAll('.attendee-chip')).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    await i18n.changeLanguage(previousLanguage);
  }
});
