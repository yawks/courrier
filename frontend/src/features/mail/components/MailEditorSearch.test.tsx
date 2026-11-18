// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { beforeAll, expect, it, vi } from 'vitest';
import { EditorSearch } from '../utils/editorSearch';
import { MailEditorSearch } from './MailEditorSearch';

vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, values?: { current: number; count: number }) => values ? `${values.current}/${values.count}` : key,
}) }));
beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

it('replaces the current match or all matches, supports empty replacement and undo without saving highlights', async () => {
  const container = document.createElement('form');
  const onSubmit = vi.fn((event: Event) => event.preventDefault());
  container.addEventListener('submit', onSubmit);
  container.className = 'mail-editor';
  document.body.append(container);
  const editor = new Editor({ extensions: [StarterKit, EditorSearch], content: '<p>Hello <strong>world</strong>, hello world.</p>', editorProps: { handleScrollToSelection: () => true } });
  const original = editor.getHTML();
  container.append(editor.view.dom);
  const ui = document.createElement('div');
  container.prepend(ui);
  const root = createRoot(ui);
  await act(async () => root.render(<MailEditorSearch editor={editor} />));
  const click = async (label: string) => { await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click()); };
  const fill = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const enter = async (index: number) => { await act(async () => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    container.querySelectorAll('input')[index].dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  }); }; 
  await click('mail.findReplace');
  await fill(container.querySelector('input[type="search"]')!, 'hello world');
  expect(container.querySelectorAll('input')).toHaveLength(1);
  expect(container.querySelector('form')).toBeNull();
  await enter(0);
  expect(onSubmit).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-expanded]')!.click());
  expect(container.querySelector('[role="status"]')?.textContent).toBe('1/2');
  expect(editor.getHTML()).toBe(original);
  // Model nested quote node views around the result paragraph.
  const paragraph = editor.view.dom.querySelector('p')!;
  const wrappers: HTMLDivElement[] = [];
  for (let level = 0; level < 2; level++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'mail-quoted--editor';
    const toggle = document.createElement('button');
    toggle.className = 'mail-quoted__toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    const details = document.createElement('div');
    details.style.display = 'none';
    toggle.onclick = () => { details.style.display = ''; toggle.setAttribute('aria-expanded', 'true'); };
    const child = wrappers.at(-1) ?? paragraph;
    child.parentNode!.insertBefore(wrapper, child);
    wrapper.append(toggle, details);
    details.append(child);
    wrappers.push(wrapper);
  }
  await click('mail.findNext');
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'nearest' });
  const scrolled = vi.mocked(HTMLElement.prototype.scrollIntoView).mock.instances.at(-1) as unknown as HTMLElement;
  expect(scrolled.classList.contains('mail-editor-search-match--active')).toBe(true);
  expect(scrolled.textContent).toBe('hello world');
  for (const wrapper of wrappers) {
    expect(wrapper.querySelector(':scope > button')?.getAttribute('aria-expanded')).toBe('true');
  }
  // Restore the DOM managed by ProseMirror before testing replacements.
  wrappers[1].replaceWith(paragraph);
  await click('mail.findPrevious');

  await fill(container.querySelectorAll('input')[1], 'Welcome');
  await enter(1);
  expect(editor.getText()).toBe('Welcome, hello world.');
  await fill(container.querySelectorAll('input')[1], '');
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'mail.replaceAll')!.click(); });
  expect(editor.getText()).toBe('Welcome, .');
  expect(container.querySelector('[role="status"]')?.textContent).toBe('0/0');
  expect(document.activeElement).toBe(container.querySelectorAll('input')[1]);
  await act(async () => { editor.commands.undo(); });
  expect(editor.getText()).toBe('Welcome, hello world.');
  expect(editor.getHTML()).not.toContain('mail-editor-search');
  // A new query must work immediately, without submitting another search.
  await fill(container.querySelectorAll('input')[0], 'Welcome');
  await fill(container.querySelectorAll('input')[1], 'Hi');
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'mail.replace')!.click(); });
  expect(editor.getText()).toBe('Hi, hello world.');
  expect(onSubmit).not.toHaveBeenCalled();
  await act(async () => { container.querySelectorAll('input')[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(container.querySelector('[role="search"]')).toBeNull();
  expect(editor.view.dom.querySelector('.mail-editor-search-match')).toBeNull();
  await act(async () => root.unmount());
  editor.destroy();
  container.remove();
});
