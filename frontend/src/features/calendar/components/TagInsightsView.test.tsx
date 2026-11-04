// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import TagInsightsView from './TagInsightsView';
import { toTUIEvents } from '../utils/calendarUtils';
import i18n from '../../../i18n';
import type { CalendarConfig, CalendarEvent, Tag } from '../../../shared/types';

const calendar = { id: 'cal', name: 'Calendar', visible: true, color: '#123456' } as CalendarConfig;
const tags: Tag[] = [{ id: 'work', name: 'Travail', color: '#ff0000' }, { id: 'sport', name: 'Sport', color: '#00ff00' }];
const events: CalendarEvent[] = tags.map((tag, index) => ({ id: tag.id, calendarId: calendar.id, title: tag.name, tagId: tag.id,
  start: `2026-11-04T${10 + index}:00:00Z`, end: `2026-11-04T${11 + index}:00:00Z`, isAllday: false, category: 'time' }));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.removeItem('insights-group'); localStorage.removeItem('insights-calendar');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it.each(['fr', 'en'])('selects, switches and toggles off a tag without hiding events or changing their data (%s)', async language => {
  await i18n.changeLanguage(language);
  function Harness() {
    const [selected, setSelected] = useState<string | null>(null);
    return <>
      <TagInsightsView calendars={[calendar]} groups={[]} events={events} eventTags={{}} tags={tags} highlightedTagId={selected}
        onHighlightTag={id => setSelected(current => current === id ? null : id)} />
      {toTUIEvents(events, [calendar], false, tags, {}, selected).map(event => <div key={event.id} data-event={event.id} data-opacity={event.customStyle.opacity ?? 1} data-highlighted={!!event.customStyle.boxShadow} />)}
    </>;
  }
  await act(async () => root.render(<Harness />));
  const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('.insights-stat--interactive'));
  const first = buttons.find(button => button.textContent?.includes('Travail'))!;
  const second = buttons.find(button => button.textContent?.includes('Sport'))!;
  const opacity = (id: string) => host.querySelector(`[data-event="${id}"]`)?.getAttribute('data-opacity');
  expect(first.getAttribute('aria-pressed')).toBe('false');
  await act(async () => first.click());
  expect(first.getAttribute('aria-pressed')).toBe('true');
  expect(first.title).toBe(i18n.t('insights.clearHighlight', { tag: 'Travail' }));
  expect(opacity('work')).toBe('1'); expect(opacity('sport')).toBe('0.25');
  await act(async () => second.click());
  expect(first.getAttribute('aria-pressed')).toBe('false');
  expect(second.getAttribute('aria-pressed')).toBe('true');
  expect(opacity('work')).toBe('0.25'); expect(opacity('sport')).toBe('1');
  await act(async () => second.click());
  expect(second.getAttribute('aria-pressed')).toBe('false');
  expect(opacity('work')).toBe('1'); expect(opacity('sport')).toBe('1');
  expect(host.querySelectorAll('[data-event]')).toHaveLength(2);
  expect(events.map(event => event.tagId)).toEqual(['work', 'sport']);
});

it('announces the calendar update and blocks repeated clicks while busy', async () => {
  const render = (busy: boolean) => root.render(<TagInsightsView calendars={[calendar]} groups={[]} events={events} eventTags={{}} tags={tags}
    highlightingTag={busy ? 'work' : null} onHighlightTag={() => { throw new Error('Busy actions must stay disabled'); }} />);
  await act(async () => render(true));
  expect(host.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe(i18n.t('insights.updatingHighlight'));
  expect(host.querySelector('[role="status"]')?.closest('button')?.textContent).toContain('Travail');
  expect(host.querySelectorAll('[aria-busy="true"]')).toHaveLength(1);
  const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('.insights-stat--interactive'));
  expect(buttons.every(button => button.disabled)).toBe(true);
  await act(async () => buttons[0].click());
  await act(async () => render(false));
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(buttons.every(button => !button.disabled)).toBe(true);
});

it('toggles Without tag and replaces it when selecting a named tag', async () => {
  const untagged = { ...events[0], id: 'untagged', tagId: undefined, start: '2026-11-04T12:00:00Z', end: '2026-11-04T13:00:00Z' };
  function Harness() {
    const [selected, setSelected] = useState<string | null>(null);
    return <TagInsightsView calendars={[calendar]} groups={[]} events={[...events, untagged]} eventTags={{}} tags={tags}
      highlightedTagId={selected} onHighlightTag={id => setSelected(current => current === id ? null : id)} />;
  }
  await act(async () => root.render(<Harness />));
  const without = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.includes(i18n.t('insights.withoutTag')))!;
  await act(async () => without.click());
  expect(without.getAttribute('aria-pressed')).toBe('true');
  expect(without.title).toBe(i18n.t('insights.clearUntaggedHighlight'));
  await act(async () => without.click());
  expect(without.getAttribute('aria-pressed')).toBe('false');
  await act(async () => without.click());
  const named = host.querySelector<HTMLButtonElement>('.insights-stat--interactive')!;
  await act(async () => named.click());
  expect(without.getAttribute('aria-pressed')).toBe('false');
  expect(named.getAttribute('aria-pressed')).toBe('true');
});
