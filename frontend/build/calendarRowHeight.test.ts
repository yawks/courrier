import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import config from '../vite.config';

it('expands every all-day row including its spacing, and still collapses', () => {
  const require = createRequire(import.meta.url);
  const id = join(dirname(require.resolve('@toast-ui/calendar')), 'toastui-calendar.mjs');
  const source = readFileSync(id, 'utf8');
  const plugin = (config.plugins as any[]).find(plugin => plugin.name === 'calendar-expanded-row-height');
  const patched = plugin.transform.call({ error: (message: string) => { throw new Error(message); } }, source, id);
  expect(patched).not.toBe(source);
  const hook = patched.slice(patched.indexOf('function useGridRowHeightController('), patched.indexOf('function requestTimeout('));
  // Exercise the shipped dependency's handlers with synchronous hook stubs.
  for (const rows of [4, 20, 100]) {
    let height = 0;
    const controller = new Function('y$1', 'T$1', 'useDispatch', 'EVENT_HEIGHT', 'WEEK_EVENT_MARGIN_TOP', 'DEFAULT_PANEL_HEIGHT', `${hook}; return useGridRowHeightController(${rows - 1}, 'allday');`)(
      () => [0, () => {}], (callback: unknown) => callback,
      () => ({ updateDayGridRowHeight: (update: { height: number }) => { height = update.height; } }),
      22, 2, 72,
    );
    controller.onClickExceedCount(0);
    expect(height).toBe(rows * 24);
    controller.onClickCollapseButton();
    expect(height).toBe(72);
  }
});
