import { apiHeaders, apiJson, apiUrl } from './apiRequest';
import { hasNativeTransport, invokeNative } from './nativeTransport';

let nextRequest = 0;

async function post<T>(path: string, body: unknown): Promise<T> {
  const requestId = ++nextRequest;
  const native = hasNativeTransport();
  const started = performance.now();
  console.info('[Exchange calendar request]', { requestId, operation: path, transport: native ? 'native' : 'web', state: 'started' });
  try {
    let result: T;
    if (native) {
      const operation = path === 'events' ? 'create' : path === 'free-busy' ? 'free_busy' : path;
      result = await invokeNative<T>(`exchange_calendar_${operation}`, body as Record<string, unknown>);
    } else {
      const response = await fetch(apiUrl(`/api/calendar/exchange/${path}`), { method: 'POST', credentials: 'same-origin', headers: apiHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body) });
      result = await apiJson<T>(response);
    }
    console.info('[Exchange calendar request]', { requestId, operation: path, state: 'completed', elapsedMs: Math.round(performance.now() - started) });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Do not log arguments, the raw error, SOAP, account addresses or tokens.
    const code = /\b(Error[A-Za-z0-9]{1,80})\b/.exec(message)?.[1] ?? 'request_failed';
    console.error('[Exchange calendar request]', { requestId, operation: path, transport: native ? 'native' : 'web', code, elapsedMs: Math.round(performance.now() - started) });
    throw error instanceof Error ? error : new Error(message);
  }
}

export const exchangeCalendarApi = {
  rooms: (request: { accessToken: string; query?: string }): Promise<Array<{ name: string; email: string; directory?: boolean }>> => post('rooms', request),
  shared: (request: Record<string, unknown>): Promise<{ calendars: Array<{ id: string; name: string }>; limitedDiscovery: boolean }> => post('shared', request),
  recurrence: (request: Record<string, unknown>): Promise<string | null> => post<string | null>('recurrence', request),
  get: <T>(request: Record<string, unknown>): Promise<T> => post<T>('get', request),
  list: <T>(request: Record<string, unknown>): Promise<T> => post<T>('list', request),
  freeBusy: <T>(request: Record<string, unknown>): Promise<T> => post<T>('free-busy', request),
  create: async (request: Record<string, unknown>): Promise<string> => {
    const result = await post<{ itemId?: string; changeKey?: string } | string>('events', request);
    return typeof result === 'string' ? result : `${result.itemId}|${result.changeKey}`;
  },
  respond: (request: Record<string, unknown>): Promise<void> => post<void>('respond', request),
  update: (request: Record<string, unknown>): Promise<void> => post<void>('update', request),
  delete: (request: Record<string, unknown>): Promise<void> => post<void>('delete', request),
  cancel: (request: Record<string, unknown>): Promise<void> => post<void>('cancel', request),
};
