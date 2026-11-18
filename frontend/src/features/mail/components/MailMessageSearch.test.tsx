// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, expect, it, vi } from 'vitest';
import { MailMessageSearch } from './MailMessageSearch';

vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, values?: { current: number; count: number }) => values ? `${values.current}/${values.count}` : key,
}) }));
beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

it('handles iframe shortcuts, search, wraparound navigation, Escape and close', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  function Mail() {
    const blockRef = useRef<HTMLDivElement>(null);
    return <div ref={blockRef} className="mail-message-block expanded"><MailMessageSearch blockRef={blockRef} /><div className="mail-email-body-stage"><iframe /></div></div>;
  }
  await act(async () => root.render(<Mail />));
  const frame = container.querySelector('iframe')!;
  const doc = frame.contentDocument!;
  doc.body.innerHTML = '<div class="ew">Hello hello</div>';
  frame.focus();
  await act(async () => {
    const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
    doc.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
  const input = container.querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'hello');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(container.querySelector('[role="status"]')?.textContent).toBe('1/2');
  expect(doc.querySelectorAll('mark')).toHaveLength(2);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="mail.findPrevious"]')!.click());
  expect(container.querySelector('[role="status"]')?.textContent).toBe('2/2');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="mail.findNext"]')!.click());
  expect(container.querySelector('[role="status"]')?.textContent).toBe('1/2');
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(container.querySelector('form')).toBeNull();
  expect(doc.querySelector('mark')).toBeNull();
  await act(async () => { doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true })); });
  expect(container.querySelector('form')).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="mail.findClose"]')!.click());
  expect(container.querySelector('form')).toBeNull();
  await act(async () => root.unmount());
  container.remove();
});
