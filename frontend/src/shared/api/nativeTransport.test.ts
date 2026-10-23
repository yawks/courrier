// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../i18n';
import { platform } from '../platform';
import { invokeNative } from './nativeTransport';
import { apiJson } from './apiRequest';
import { ewsRetryAt, ExchangeBusyError } from '../utils/ewsError';

vi.mock('../platform', () => ({ platform: { mailCommand: vi.fn() } }));
vi.mock('../platform/tauriRuntime', () => ({ getTauriInvoke: () => undefined }));

afterEach(() => vi.mocked(platform.mailCommand!).mockReset());

describe('Exchange cooldown at transport boundaries', () => {
  it.each(['mail_send', 'exchange_calendar_create'])('never replays %s after throttling', async command => {
    const deadline = Date.now() + 300_000;
    vi.mocked(platform.mailCommand!).mockRejectedValue(`ews_server_busy:${deadline}`);
    let caught: unknown;
    try { await invokeNative(command, {}); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ExchangeBusyError);
    expect(ewsRetryAt(caught)).toBe(deadline);
    expect(platform.mailCommand).toHaveBeenCalledTimes(1);
  });

  it('translates the same error from the web backend', async () => {
    const deadline = Date.now() + 300_000;
    const response = new Response(JSON.stringify({ error: `ews_server_busy:${deadline}` }), { status: 500 });
    await expect(apiJson(response)).rejects.toMatchObject({ retryAt: deadline });
  });

  it('preserves an uncertain write failure without a retry', async () => {
    const error = new Error('Connection reset after sending');
    vi.mocked(platform.mailCommand!).mockRejectedValue(error);
    await expect(invokeNative('mail_send')).rejects.toBe(error);
    expect(platform.mailCommand).toHaveBeenCalledTimes(1);
  });
});
