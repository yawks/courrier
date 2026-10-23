import i18n from 'i18next';

/** Absolute deadline survives transport wrapping and does not restart on each retry. */
export function ewsRetryAt(error: unknown): number | undefined {
  if (error instanceof ExchangeBusyError) return error.retryAt;
  const message = error instanceof Error ? error.message : String(error ?? '');
  const match = /ews_server_busy:(\d+)/.exec(message);
  if (!match) return undefined;
  const deadline = Number(match[1]);
  return Number.isSafeInteger(deadline) ? deadline : undefined;
}

export class ExchangeBusyError extends Error {
  constructor(readonly retryAt: number) {
    super(i18n.t('exchangeBusy', { seconds: Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)) }));
    this.name = 'ExchangeBusyError';
  }
}

export function localizeEwsError(error: unknown): unknown {
  const deadline = ewsRetryAt(error);
  return deadline === undefined ? error : new ExchangeBusyError(deadline);
}

export function temporaryServiceRetryDelay(attempt: number, error: unknown): number {
  const deadline = ewsRetryAt(error);
  if (deadline === undefined) return Math.min(2_000 * 2 ** attempt, 10_000);
  const backoff = Math.min(2_000 * 2 ** attempt, 10_000);
  return Math.max(backoff, (deadline ?? 0) - Date.now()) + Math.floor(Math.random() * 1_000);
}
