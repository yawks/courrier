// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, expect, it, vi } from 'vitest';
import { MailSearchBar, parseSearchInput } from './MailSearchBar';
import en from '../../../locales/en/translation.json';
import fr from '../../../locales/fr/translation.json';

const language = vi.hoisted(() => ({ current: 'en' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, fallback: string) => key === 'mail.search.hasAttachment'
    ? (language.current === 'fr' ? fr : en).mail.search.hasAttachment : fallback,
}) }));
beforeAll(() => Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }));

it('parses attachment filters with other criteria and preserves unsupported has values as text', () => {
  expect(parseSearchInput('HAS:Attachment from:alice report')).toEqual({
    hasAttachment: true, from: 'alice', text: 'report',
  });
  expect(parseSearchInput('has:attachment')).toEqual({ hasAttachment: true });
  expect(parseSearchInput('has:unknown')).toEqual({ text: 'has:unknown' });
});

it.each(['en', 'fr'])('completes has, submits an attachment-only search and restores it (%s)', async lang => {
  language.current = lang;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onSearch = vi.fn();
  await act(async () => root.render(<MailSearchBar activeQuery={null} onSearch={onSearch} />));
  const input = host.querySelector('input')!;
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'has');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(host.querySelector('.mail-search-suggestion')?.textContent).toBe(
    (lang === 'fr' ? fr : en).mail.search.hasAttachment,
  );
  for (const key of ['ArrowDown', 'Enter', 'Enter']) {
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
  }
  expect(onSearch).toHaveBeenLastCalledWith({ hasAttachment: true });
  await act(async () => root.render(<MailSearchBar activeQuery={{ hasAttachment: true }} onSearch={onSearch} />));
  expect(input.value).toBe('has:attachment');
  expect(host.querySelector('.mail-search-bar--active')).not.toBeNull();
  await act(async () => root.unmount());
  host.remove();
});
