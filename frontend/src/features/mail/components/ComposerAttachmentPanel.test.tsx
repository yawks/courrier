// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ComposerAttachmentPanel } from './ComposerAttachmentPanel';
import type { ComposerAttachment } from '../providers/MailProvider';
import type { AttachmentPreviewModalProps } from './AttachmentPreviewModal';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../utils', () => ({ FileTypeIcon: () => null, formatSize: (size: number) => `${size} B` }));
const mocks = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock('./AttachmentPreviewModal', () => ({
  AttachmentPreviewModal: (props: AttachmentPreviewModalProps) => {
    mocks.preview(props);
    return <dialog open aria-label={props.attachment.name}>
      <button onClick={props.onClose}>Close</button>
    </dialog>;
  },
}));

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
const onRemove = vi.fn();
const file = (name: string, contentType: string): ComposerAttachment => ({
  name, contentType, size: 4, data: 'dGVzdA==',
});
const render = async (attachments: ComposerAttachment[]) => {
  await act(async () => root.render(<ComposerAttachmentPanel attachments={attachments} onRemove={onRemove} />));
};
const previewButton = () => host.querySelector<HTMLButtonElement>('[aria-label="mail.attachment.preview"]');
const previewProps = () => mocks.preview.mock.lastCall![0] as AttachmentPreviewModalProps;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it.each([
  ['photo.png', 'image/png'],
  ['document.pdf', 'application/pdf'],
  ['DOCUMENT.PDF', 'application/octet-stream'],
])('previews %s using the local attachment without removing it', async (name, type) => {
  const attachment = file(name, type);
  await render([attachment]);
  await act(async () => previewButton()!.click());
  expect(host.querySelector('dialog')?.getAttribute('aria-label')).toBe(name);
  expect(previewProps().data).toBe(attachment.data);
  expect(previewProps().attachment.content_type).toBe(type);
  expect(previewProps().loading).toBe(false);
  expect(onRemove).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>('dialog button')!.click());
  expect(host.querySelector('dialog')).toBeNull();
});

it.each(['docx', 'xlsx'])('loads local %s bytes for the shared Office viewer', async extension => {
  await render([file(`document.${extension}`, 'application/octet-stream')]);
  await act(async () => previewButton()!.click());
  expect(previewProps().data).toBeNull();
  const bytes = await previewProps().loadOffice!();
  expect(Array.from(new Uint8Array(bytes))).toEqual([116, 101, 115, 116]);
});

it('keeps the Office preview size limit', async () => {
  await render([{ ...file('large.docx', 'application/octet-stream'), size: 21 * 1024 * 1024 }]);
  await act(async () => previewButton()!.click());
  await expect(previewProps().loadOffice!()).rejects.toThrow('office-size-limit');
});

it('retains removal and does not offer an empty preview for unsupported files', async () => {
  await render([file('archive.zip', 'application/zip')]);
  expect(previewButton()).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="eventModal.delete"]')!.click());
  expect(onRemove).toHaveBeenCalledWith(0);
});

it('dismisses the preview when its attachment is removed or replaced', async () => {
  const first = file('first.png', 'image/png');
  const second = file('second.png', 'image/png');
  await render([first, second]);
  await act(async () => previewButton()!.click());
  await render([second]);
  expect(host.querySelector('dialog')).toBeNull();
  await act(async () => previewButton()!.click());
  expect(host.querySelector('dialog')?.getAttribute('aria-label')).toBe(second.name);
  await render([]);
  expect(host.innerHTML).toBe('');
});
