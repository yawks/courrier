import { localizeEwsError } from '../utils/ewsError';
import { platform } from '../platform';
import { getTauriInvoke } from '../platform/tauriRuntime';

export function hasNativeTransport(): boolean {
  return Boolean(platform.mailCommand || getTauriInvoke());
}

export async function invokeNative<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    if (platform.mailCommand) return await platform.mailCommand<T>(command, args);
    const invoke = getTauriInvoke();
    if (!invoke) throw new Error('Native transport unavailable');
    return await invoke<T>('mail_command', { command, args });
  } catch (error) {
    throw localizeEwsError(error);
  }
}
