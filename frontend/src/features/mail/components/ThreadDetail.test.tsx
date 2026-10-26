// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { ThreadDetail, type ThreadDetailProps } from './ThreadDetail';
import type { MailMessage, MailThread } from '../types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../shared/platform/notificationOpening', () => ({ useNotificationOpening: () => null }));
vi.mock('./MessageBlockHeader', () => ({ MessageBlockHeader: ({ message, onToggleExpand }: { message: MailMessage; onToggleExpand: () => void }) => <button data-message={message.item_id} onClick={onToggleExpand}>{message.item_id}</button> }));
vi.mock('./EmailHtmlBody', () => ({ EmailHtmlBody: () => null }));
vi.mock('./ICSInvitationCard', () => ({ ICSInvitationCard: () => null }));
vi.mock('./MailComposer', () => ({ MailComposer: () => null }));
vi.mock('./CollapsedMessagesBar', () => ({ CollapsedMessagesBar: () => null }));
vi.mock('./FolderPickerPopover', () => ({ FolderPickerPopover: () => null }));

it('reads only opened blocks and leaves incoming messages collapsed and unread', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} });
  const container = document.createElement('div');
  const root = createRoot(container);
  const client = new QueryClient();
  const onMarkRead = vi.fn();
  const props = { messagesLoading: false, replyingTo: null, contacts: [], moveFolders: [], supportsSnooze: false, onMarkRead } as unknown as ThreadDetailProps;
  const message = (id: string, read = false) => ({ item_id: id, is_read: read, subject: 'Mail', date_time_received: '', attachments: [] }) as unknown as MailMessage;
  const render = async (messages: MailMessage[], fetching = false, conversationId = 'thread') => {
    const thread = { conversation_id: conversationId, accountId: 'account', topic: 'Mail', unread_count: messages.filter(m => !m.is_read).length } as MailThread;
    await act(async () => root.render(<QueryClientProvider client={client}><ThreadDetail {...props} thread={thread} messages={messages} messagesFetching={fetching} /></QueryClientProvider>));
  };
  const open = async (id: string) => act(async () => { (container.querySelector(`[data-message="${id}"]`) as HTMLButtonElement).click(); });
  try {
    await render([message('older'), message('latest')], true);
    expect(onMarkRead).not.toHaveBeenCalled();
    await render([message('older'), message('latest')]);
    expect(onMarkRead.mock.calls.map(([msgs]) => msgs.map((m: MailMessage) => m.item_id))).toEqual([['latest']]);
    await render([message('older'), message('latest', true), message('new-1'), message('new-2')]);
    expect(container.querySelectorAll('[data-message]')).toHaveLength(4);
    expect(container.querySelectorAll('.mail-message-block__body')).toHaveLength(1);
    expect(onMarkRead).toHaveBeenCalledTimes(1);
    await open('new-1');
    expect(onMarkRead.mock.calls.at(-1)?.[0]).toEqual([message('new-1')]);
    await open('new-2');
    expect(onMarkRead.mock.calls.at(-1)?.[0]).toEqual([message('new-2')]);
    await render([message('older'), message('latest'), message('new-1'), message('new-2')]);
    expect(onMarkRead).toHaveBeenCalledTimes(3);
    await open('older');
    expect(onMarkRead.mock.calls.at(-1)?.[0]).toEqual([message('older')]);
    await render([message('other', true)], false, 'other');
    await render([message('latest')]);
    expect(onMarkRead).toHaveBeenCalledTimes(5);
  } finally {
    await act(async () => root.unmount());
    client.clear();
  }
});
