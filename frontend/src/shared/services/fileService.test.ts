import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileService, openExternalUrl } from './fileService';

describe('fileService', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('downloads standard and URL-safe base64 through a Blob URL', () => {
    const click = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() });
    vi.stubGlobal('document', { createElement: vi.fn(() => ({ click })) });
    fileService.downloadBase64('hello.txt', 'SGVsbG8tXw', 'text/plain');
    expect(click).toHaveBeenCalled();
  });

  it('keeps the saved desktop path for the system opener', async () => {
    const invoke = vi.fn().mockResolvedValueOnce('/downloads/hello (1).txt').mockResolvedValueOnce(undefined);
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
    const open = await fileService.downloadOpenable('hello.txt', 'SGVsbG8=', 'text/plain');
    expect(invoke).toHaveBeenNthCalledWith(1, 'save_download', { name: 'hello.txt', bytes: [72, 101, 108, 108, 111] });
    await open?.();
    expect(invoke).toHaveBeenNthCalledWith(2, 'open_download', { path: '/downloads/hello (1).txt' });
  });

  it('does not offer an opener when saving fails', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: vi.fn().mockRejectedValue(new Error('disk full')) });
    await expect(fileService.downloadOpenable('hello.txt', 'SGVsbG8=')).rejects.toThrow('disk full');
  });

  it('only opens safe external protocols', () => {
    const open = vi.fn();
    vi.stubGlobal('location', { href: 'https://courrier.example/' });
    vi.stubGlobal('open', open);
    expect(openExternalUrl('javascript:alert(1)')).toBe(false);
    expect(openExternalUrl('https://example.com/path')).toBe(true);
    expect(open).toHaveBeenCalledWith('https://example.com/path', '_blank', 'noopener,noreferrer');
  });
});
