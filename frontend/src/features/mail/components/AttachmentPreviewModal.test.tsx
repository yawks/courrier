// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AttachmentPreviewModal } from './AttachmentPreviewModal';

const mocks = vi.hoisted(() => ({ fail: false, scales: [] as number[], destroy: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../utils', () => ({ FileTypeIcon: () => null }));
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    destroy: mocks.destroy,
    promise: Promise.resolve({ numPages: 1, getPage: async () => ({
      getViewport: ({ scale }: { scale: number }) => { mocks.scales.push(scale); return { width: 600 * scale, height: 800 * scale }; },
      render: () => ({ promise: mocks.fail ? Promise.reject(new Error('invalid PDF')) : Promise.resolve() }),
    }) }),
  }),
}));

const attachment = { attachment_id: 'pdf', name: 'document.pdf', content_type: 'application/pdf', size: 4, is_inline: false };
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
const button = (key: string) => document.querySelector<HTMLButtonElement>(`[aria-label="mail.office.${key}"]`)!;
const render = async (props = {}) => {
  await act(async () => root.render(<AttachmentPreviewModal attachment={attachment} loading={false} data="dGVzdA==" onClose={() => {}} {...props} />));
};

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.fail = false;
  mocks.scales.length = 0;
  mocks.destroy.mockClear();
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('changes actual PDF canvas dimensions, enforces bounds and resets for another attachment', async () => {
  await render();
  expect(document.querySelector('iframe')).toBeNull();
  expect(document.querySelector('canvas')?.style.width).toBe('600px');
  await act(async () => button('zoomIn').click());
  expect(document.querySelector('canvas')?.style.width).toBe('750px');
  expect(document.querySelector('canvas')?.width).toBe(750);
  expect(document.querySelector('.mail-preview-modal__pdf-toolbar [role="status"]')?.textContent).toBe('125%');
  for (let i = 0; i < 10; i++) await act(async () => button('zoomIn').click());
  expect(button('zoomIn').disabled).toBe(true);
  expect(document.querySelector('canvas')?.style.width).toBe('1800px');
  for (let i = 0; i < 12; i++) await act(async () => button('zoomOut').click());
  expect(button('zoomOut').disabled).toBe(true);
  expect(document.querySelector('canvas')?.style.width).toBe('300px');
  await render({ attachment: { ...attachment, attachment_id: 'other' } });
  expect(document.querySelector('canvas')?.style.width).toBe('600px');
});

it('disables zoom while loading and does not show PDF controls for images', async () => {
  await render({ loading: true, data: null });
  expect(button('zoomIn').disabled).toBe(true);
  expect(button('zoomOut').disabled).toBe(true);
  await render({ attachment: { ...attachment, name: 'image.png', content_type: 'image/png' } });
  expect(document.querySelector('.mail-preview-modal__pdf-toolbar')).toBeNull();
});

it('cleans up obsolete documents without leaving duplicate canvases', async () => {
  await render();
  expect(document.querySelector('canvas')?.style.width).toBe('600px');
  await act(async () => button('zoomIn').click());
  expect(document.querySelector('canvas')?.style.width).toBe('750px');
  expect(document.querySelectorAll('canvas')).toHaveLength(1);
  expect(mocks.destroy).toHaveBeenCalledOnce();
  await act(async () => button('zoomOut').click());
  expect(document.querySelector('canvas')?.style.width).toBe('600px');
});

it('announces rendering errors instead of claiming the preview is ready', async () => {
  mocks.fail = true;
  await render();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('mail.office.error');
  expect(document.querySelector('.mail-preview-modal__pdf-viewport')?.getAttribute('aria-busy')).toBe('false');
});
