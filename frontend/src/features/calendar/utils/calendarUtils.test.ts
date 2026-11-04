import { describe, expect, it } from 'vitest';
import { CalendarConfig, CalendarEvent, Tag } from '../../../shared/types';
import { UNTAGGED_HIGHLIGHT, escapeCalendarText, getEventColorStyle, toTUIEvents } from './calendarUtils';

it('escapes remote titles before inserting them into calendar HTML templates', () => {
  expect(escapeCalendarText('<img src=x onerror="alert(1)"> & \'task\''))
    .toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;task&#39;');
});

const calendar: CalendarConfig = {
  id: 'calendar-1',
  name: 'Calendar',
  url: '',
  color: '#123456',
  visible: true,
};

const tag: Tag = {
  id: 'tag-1',
  name: 'Focus',
  color: '#abcdef',
};

const event: CalendarEvent = {
  id: 'temp-1',
  calendarId: calendar.id,
  title: 'New event',
  start: '2099-01-01T10:00:00.000Z',
  end: '2099-01-01T11:00:00.000Z',
  isAllday: false,
  category: 'time',
  tagId: tag.id,
};

describe('toTUIEvents', () => {
  it('keeps all-day events on their calendar dates and converts the exclusive end', () => {
    const allDayEvent = {
      ...event,
      start: '2026-08-26T00:00:00.000Z',
      end: '2026-08-28T00:00:00.000Z',
      isAllday: true,
      category: 'allday' as const,
    };

    const [result] = toTUIEvents([allDayEvent], [calendar], false, [], {});

    expect(result.start).toBe('2026-08-26');
    expect(result.end).toBe('2026-08-27');
  });

  it('uses local calendar dates for offset all-day timestamps', () => {
    const allDayEvent = {
      ...event,
      start: '2026-09-02T22:00:00.000Z',
      end: '2026-09-04T22:00:00.000Z',
      isAllday: true,
      category: 'allday' as const,
    };

    const [result] = toTUIEvents([allDayEvent], [calendar], false, [], {});

    expect(result.start).toBe('2026-09-03');
    expect(result.end).toBe('2026-09-04');
  });

  it('applies a tag carried by a newly-created event before it has a server ID', () => {
    const [result] = toTUIEvents([event], [calendar], false, [tag], {});

    expect(result.raw.tagColor).toBe(tag.color);
  });

  it('prefers the persisted server mapping once one is available', () => {
    const mappedTag: Tag = { id: 'tag-2', name: 'Meeting', color: '#fedcba' };
    const persistedEvent = { ...event, seriesId: 'server-1' };
    const [result] = toTUIEvents(
      [persistedEvent],
      [calendar],
      false,
      [tag, mappedTag],
      { 'server-1': mappedTag.id },
    );

    expect(result.raw.tagColor).toBe(mappedTag.color);
  });

  it('paints tentative hatching on the full TUI event container', () => {
    const [result] = toTUIEvents(
      [{ ...event, selfRsvpStatus: 'TENTATIVE' }],
      [calendar],
      false,
      [],
      {},
    );

    expect(result.customStyle.backgroundImage).toBe(
      'repeating-linear-gradient(-45deg, rgba(18,52,86,0.3) 0, rgba(18,52,86,0.3) 4px, transparent 4px, transparent 8px)',
    );
    expect(result.raw).not.toHaveProperty('hatchColor');
  });
});

describe('getEventColorStyle', () => {
  it('uses white text on Google blue in dark mode', () => {
    expect(getEventColorStyle('#1a73e8', false, true)).toEqual({
      backgroundColor: '#1a73e8',
      textColor: '#ffffff',
    });
  });

  it('uses white text on vivid red in dark mode', () => {
    expect(getEventColorStyle('#FF4245', false, true)).toEqual({
      backgroundColor: '#FF4245',
      textColor: '#ffffff',
    });
  });

  it.each(['#EA4335', 'rgb(234, 67, 53)'])('uses white text on Google red %s', (color) => {
    expect(getEventColorStyle(color, false, true)).toEqual({
      backgroundColor: color,
      textColor: '#ffffff',
    });
  });

  it('uses dark text on a bright upcoming event in dark mode', () => {
    expect(getEventColorStyle('#e85d3f', false, true)).toEqual({
      backgroundColor: '#e85d3f',
      textColor: '#111315',
    });
  });

  it('keeps a past event coloured while muting it against the dark grid', () => {
    expect(getEventColorStyle('#4b9bd1', true, true)).toEqual({
      backgroundColor: '#2f5a77',
      textColor: '#94bcd7',
    });
  });
});

it('never displays a tag on a read-only shared copy of the same series', () => {
  const shared = { ...calendar, type: 'google' as const, shared: { ownerEmail: 'other@example.com' } };
  const [result] = toTUIEvents([{ ...event, seriesId: 'same-series', tagId: tag.id }], [shared], false, [tag], { 'same-series': tag.id });
  expect(result.raw.tagColor).toBeUndefined();
  expect(result.isReadOnly).toBe(true);
});

it.each(['google', 'exchange', 'nextcloud', 'ics'] as const)('highlights %s series and all-day events by tag, preserves status styles and restores the original render', type => {
  const cal = { ...calendar, type };
  const original = [
    { ...event, id: 'instance', seriesId: 'series', tagId: undefined },
    { ...event, id: 'all-day', isAllday: true, start: '2099-01-01', end: '2099-01-02' },
    { ...event, id: 'past-pending', tagId: undefined, isUnaccepted: true, isDeclined: true, start: '2020-01-01T10:00:00Z', end: '2020-01-01T11:00:00Z' },
  ];
  const before = toTUIEvents(original, [cal], true, [tag], { series: tag.id });
  const highlighted = toTUIEvents(original, [cal], true, [tag], { series: tag.id }, tag.id);
  expect(highlighted[0].customStyle.boxShadow).toContain('var(--primary)');
  expect(highlighted[1].customStyle.boxShadow).toContain('var(--primary)');
  expect(Number(highlighted[2].customStyle.opacity)).toBeCloseTo(Number(before[2].customStyle.opacity) * .25);
  expect(highlighted[2].customStyle.textDecoration).toBe('line-through');
  expect(highlighted[2].customStyle.outline).toBe(before[2].customStyle.outline);
  expect(highlighted.map(event => event.id)).toEqual(before.map(event => event.id));
  expect(toTUIEvents(original, [cal], true, [tag], { series: tag.id }, null)).toEqual(before);
});

it('never highlights a shared-calendar copy even if it carries the selected tag', () => {
  const [result] = toTUIEvents([event], [{ ...calendar, shared: { ownerEmail: 'other@example.test' } }], false, [tag], {}, tag.id);
  expect(result.customStyle.opacity).toBe('0.25');
  expect(result.customStyle.boxShadow).toBeUndefined();
});

it('highlights only untagged personal events and restores their normal appearance', () => {
  const untagged = { ...event, id: 'untagged', tagId: undefined };
  const shared = { ...calendar, id: 'shared', shared: { ownerEmail: 'other@example.test' } };
  const results = toTUIEvents([event, untagged, { ...untagged, id: 'copy', calendarId: 'shared' }], [calendar, shared], false, [tag], {}, UNTAGGED_HIGHLIGHT);
  expect(results[0].customStyle.opacity).toBe('0.25');
  expect(results[1].customStyle.boxShadow).toContain('var(--primary)');
  expect(results[2].customStyle.opacity).toBe('0.25');
});
