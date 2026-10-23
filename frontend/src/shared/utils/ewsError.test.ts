// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { ExchangeBusyError, ewsRetryAt, localizeEwsError, temporaryServiceRetryDelay } from './ewsError';
import { isTemporaryMailServiceError } from './networkError';

afterEach(() => { vi.restoreAllMocks(); });

describe('Exchange throttling errors', () => {
  it('keeps the absolute deadline through native and HTTP error wrapping', () => {
    const deadline = Date.now() + 299321;
    for (const raw of [`ews_server_busy:${deadline}`, new Error(`ews_server_busy:${deadline}`)]) {
      const error = localizeEwsError(raw);
      expect(error).toBeInstanceOf(ExchangeBusyError);
      expect(ewsRetryAt(error)).toBe(deadline);
      expect(isTemporaryMailServiceError(error)).toBe(true);
      expect((error as Error).message).not.toContain('ews_server_busy');
    }
  });

  it.each(['fr', 'en'])('translates the pause in %s', async language => {
    await i18n.changeLanguage(language);
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const message = new ExchangeBusyError(300_321).message;
    expect(message).toContain('300');
    expect(message).toContain(language === 'fr' ? 'temporairement occupé' : 'temporarily busy');
  });

  it('waits until the deadline plus jitter, then uses a bounded retry delay', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const error = new ExchangeBusyError(300_321);
    expect(temporaryServiceRetryDelay(0, error)).toBe(299_821);
    vi.spyOn(Date, 'now').mockReturnValue(301_000);
    expect(temporaryServiceRetryDelay(2, error)).toBe(8_500);
    expect(temporaryServiceRetryDelay(0, new Error('other provider'))).toBe(2_000);
  });

  it('preserves unrelated errors, including uncertain writes', () => {
    const error = new Error('Connection reset');
    expect(localizeEwsError(error)).toBe(error);
    expect(ewsRetryAt('ews_server_busy:99999999999999999999')).toBeUndefined();
  });
});
