// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { NativeDeepLinks } from './NativeDeepLinks';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(), setActiveTab: vi.fn(), reveal: vi.fn(),
  sharePending: vi.fn(), consume: vi.fn(), invalidate: vi.fn(), cancel: vi.fn(), exit: vi.fn(),
  listeners: new Map<string, (event: any) => void>(),
}));
vi.mock('./nativeAndroid', () => ({ androidShare: { pending: mocks.sharePending } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@capacitor/app', () => ({ App: {
  exitApp: mocks.exit,
  getLaunchUrl: async () => undefined,
  addListener: async (name: string, listener: (event: any) => void) => {
    mocks.listeners.set(name, listener);
    return { remove: vi.fn() };
  },
} }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../store/LayoutStore', () => ({ useLayout: () => ({ setActiveTab: mocks.setActiveTab }) }));
vi.mock('../store/ThemeStore', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('.', () => ({ platform: {
  isNativeAndroid: true, consumeNotificationUrl: mocks.consume,
  revealNotificationView: mocks.reveal,
} }));
vi.mock('../queryClient', () => ({ queryClient: {
  invalidateQueries: mocks.invalidate, cancelQueries: mocks.cancel,
} }));
vi.mock('../../features/mail/components/ContactAvatar', () => ({ ContactAvatar: () => null }));

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.listeners.clear();
  mocks.consume.mockResolvedValue(null);
  mocks.sharePending.mockResolvedValue(false);
  mocks.cancel.mockResolvedValue(undefined);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<NativeDeepLinks />));
  vi.clearAllMocks();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Android resume', () => {
  it.each(['gmail', 'ews', 'imap', 'jmap'].flatMap(provider =>
    [false, true].map(cached => ({ provider, cached })),
  ))('replaces suspended $provider reads (cached: $cached) and ignores late results', async ({ provider, cached }) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = ['mail', provider, 'threads', 'inbox', 50, 0];
    if (cached) client.setQueryData(key, ['cached-message']);
    let finishOldRead!: (value: string[]) => void;
    const read = vi.fn()
      .mockImplementationOnce(() => new Promise<string[]>(resolve => { finishOldRead = resolve; }))
      .mockResolvedValue(['new-message']);
    // No cache: invalidateQueries alone reuses this unfinished request rather
    // than starting a replacement, even with its default cancelRefetch option.
    const observer = new QueryObserver(client, { queryKey: key, queryFn: read });
    const unsubscribe = observer.subscribe(() => {});
    const inactiveKey = ['mail', 'inactive', 'threads', 'inbox'];
    client.setQueryData(inactiveKey, ['cached']);
    mocks.cancel.mockImplementation(filters => client.cancelQueries(filters));
    mocks.invalidate.mockImplementation(filters => client.invalidateQueries(filters));
    try {
      expect(read).toHaveBeenCalledOnce();
      await act(async () => mocks.listeners.get('appStateChange')!({ isActive: true }));
      expect(read).toHaveBeenCalledTimes(2);
      expect(client.getQueryData(key)).toEqual(['new-message']);
      finishOldRead(['old-message']);
      await act(async () => { await Promise.resolve(); });
      expect(client.getQueryData(key)).toEqual(['new-message']);
      expect(client.getQueryState(key)?.fetchStatus).toBe('idle');
      expect(client.getQueryData(inactiveKey)).toEqual(['cached']);
    } finally {
      unsubscribe();
      client.clear();
      mocks.cancel.mockReset().mockResolvedValue(undefined);
      mocks.invalidate.mockReset();
    }
  });

  it('keeps the preview when a previous conversation reports its body ready', async () => {
    await act(async () => mocks.listeners.get('appUrlOpen')!({ url: 'courrier://mail/account/a/conversation/b' }));
    await act(async () => globalThis.dispatchEvent(new CustomEvent('courrier:notification-opened', {
      detail: { accountId: 'a', conversationId: 'previous' },
    })));
    expect(host.querySelector('.notification-opening')).not.toBeNull();
    await act(async () => globalThis.dispatchEvent(new CustomEvent('courrier:notification-opened', {
      detail: { accountId: 'other-account', conversationId: 'b' },
    })));
    expect(host.querySelector('.notification-opening')).not.toBeNull();
    await act(async () => globalThis.dispatchEvent(new CustomEvent('courrier:notification-opened', {
      detail: { accountId: 'a', conversationId: 'b' },
    })));
    expect(host.childElementCount).toBe(0);
  });

  it('returns to the list from the preview back button', async () => {
    const url = 'courrier://mail/account/a/conversation/b';
    await act(async () => mocks.listeners.get('appUrlOpen')!({ url }));
    const button = host.querySelector<HTMLButtonElement>('.notification-opening__nav button')!;
    expect(button.getAttribute('aria-label')).toBeTruthy();
    await act(async () => button.click());
    expect(host.childElementCount).toBe(0);
    expect(mocks.navigate).toHaveBeenLastCalledWith('/', { replace: true });
    await act(async () => mocks.listeners.get('appUrlOpen')!({ url }));
    expect(host.childElementCount).toBe(0);
  });

  it('dismisses only an unavailable notification matching the current target', async () => {
    await act(async () => mocks.listeners.get('appUrlOpen')!({ url: 'courrier://mail/account/a/conversation/b' }));
    for (const [accountId, conversationId, accepted] of [['a', 'old', false], ['other', 'b', false], ['a', 'b', true]] as const) {
      const event = new CustomEvent('courrier:notification-unavailable', { cancelable: true, detail: { accountId, conversationId } });
      await act(async () => { globalThis.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(accepted);
      expect(host.childElementCount).toBe(accepted ? 0 : 1);
    }
    expect(mocks.navigate).toHaveBeenLastCalledWith('/', { replace: true });
  });

  it('keeps the native cover until the preview has committed and painted', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const url = 'courrier://mail/account/a/conversation/b';
    await act(async () => {
      mocks.listeners.get('appUrlOpen')!({ url });
      expect(host.querySelector('.notification-opening')).not.toBeNull();
    });
    expect(host.querySelector('.notification-opening')).not.toBeNull();
    expect(mocks.reveal).not.toHaveBeenCalled();
    await act(async () => {
      mocks.listeners.get('appUrlOpen')!({ url });
      mocks.listeners.get('appStateChange')!({ isActive: true });
    });
    expect(mocks.reveal).not.toHaveBeenCalled();
    await act(async () => frames.shift()!(0));
    expect(mocks.reveal).not.toHaveBeenCalled();
    await act(async () => frames.shift()!(0));
    expect(mocks.reveal).toHaveBeenCalledOnce();
  });

  it('lets the mail screen handle Back and removes the notification cover', async () => {
    await act(async () => mocks.listeners.get('appUrlOpen')!({ url: 'courrier://mail/account/a/conversation/b' }));
    expect(host.childElementCount).toBe(1);
    const handleBack = (event: Event) => event.preventDefault();
    globalThis.addEventListener('courrier:android-back', handleBack, { once: true });
    await act(async () => mocks.listeners.get('backButton')!({ canGoBack: true }));
    expect(host.childElementCount).toBe(0);
    expect(mocks.exit).not.toHaveBeenCalled();
  });

  it('exits when no screen handles Back and there is no history', async () => {
    await act(async () => mocks.listeners.get('backButton')!({ canGoBack: false }));
    expect(mocks.exit).toHaveBeenCalledOnce();
  });

  it('reveals the current screen and refreshes mail without navigating', async () => {
    await act(async () => {
      mocks.listeners.get('appStateChange')!({ isActive: false });
      mocks.listeners.get('appStateChange')!({ isActive: true });
    });
    expect(mocks.reveal).toHaveBeenCalledOnce();
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ['mail'], refetchType: 'active' });
    expect(mocks.cancel).toHaveBeenCalledWith({ queryKey: ['mail'], type: 'active' });
    expect(mocks.cancel.mock.invocationCallOrder[0]).toBeLessThan(mocks.invalidate.mock.invocationCallOrder[0]);
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.setActiveTab).not.toHaveBeenCalled();
    expect(host.childElementCount).toBe(0);
  });

  it('refreshes mail even when the native notification lookup never returns', async () => {
    mocks.consume.mockReturnValue(new Promise(() => {}));
    await act(async () => mocks.listeners.get('appStateChange')!({ isActive: true }));
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ['mail'], refetchType: 'active' });
  });

  it('refreshes mail even when the native notification lookup fails', async () => {
    mocks.consume.mockRejectedValue(new Error('Native bridge unavailable'));
    await act(async () => mocks.listeners.get('appStateChange')!({ isActive: true }));
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ['mail'], refetchType: 'active' });
    expect(mocks.reveal).toHaveBeenCalledOnce();
  });

  it('retires unfinished reads when connectivity returns', async () => {
    await act(async () => { globalThis.dispatchEvent(new Event('online')); });
    expect(mocks.cancel).toHaveBeenCalledWith({ queryKey: ['mail'], type: 'active' });
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ['mail'], refetchType: 'active' });
  });

  it('refreshes on screen wake without a Capacitor resume event', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(mocks.cancel).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ['mail'], refetchType: 'active' });
  });

  it('coalesces screen wake and Capacitor resume without restarting twice', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      mocks.listeners.get('appStateChange')!({ isActive: true });
      globalThis.dispatchEvent(new Event('online'));
    });
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.invalidate).toHaveBeenCalledOnce();
  });

  it('reveals the WebView when a duplicate notification is ignored', async () => {
    const url = 'courrier://mail/account/a/conversation/b';
    await act(async () => mocks.listeners.get('appUrlOpen')!({ url }));
    expect(mocks.navigate).toHaveBeenCalledOnce();
    mocks.reveal.mockClear();
    await act(async () => mocks.listeners.get('appUrlOpen')!({ url }));
    expect(mocks.reveal).toHaveBeenCalledOnce();
    expect(mocks.navigate).toHaveBeenCalledOnce();
  });

  it('reveals the WebView when a notification target is rejected', async () => {
    await act(async () => mocks.listeners.get('appUrlOpen')!({ url: 'courrier://mail/invalid' }));
    expect(mocks.reveal).toHaveBeenCalledOnce();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(host.childElementCount).toBe(0);
  });
});


describe('Android shares', () => {
  it('opens the mail tab when a share arrives while the app is running', async () => {
    mocks.sharePending.mockResolvedValue(true);
    const received = vi.fn();
    globalThis.addEventListener('courrier:share-available', received);
    await act(async () => { globalThis.dispatchEvent(new Event('courrier:share-ready')); });
    expect(mocks.setActiveTab).toHaveBeenCalledWith('mail');
    expect(mocks.navigate).toHaveBeenCalledWith('/');
    expect(received).toHaveBeenCalledTimes(1);
    globalThis.removeEventListener('courrier:share-available', received);
  });

  it('checks retained shares when Android resumes', async () => {
    mocks.sharePending.mockResolvedValue(true);
    await act(async () => mocks.listeners.get('appStateChange')!({ isActive: true }));
    expect(mocks.setActiveTab).toHaveBeenCalledWith('mail');
  });
});
