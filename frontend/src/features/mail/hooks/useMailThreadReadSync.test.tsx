// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { useMailConversationRefresh, useMailConversationReadSync, useMailThreadReadSync } from './useMailThreadReadSync';
import { MAIL_KEYS } from './useMailQueries';
import type { MailMessage, MailThread } from '../types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('keeps a read invitation read in cached and accumulated rows after leaving its detail', async () => {
  const client = new QueryClient();
  const root = createRoot(document.createElement('div'));
  const rows = [{ conversation_id: 'invitation', unread_count: 1, accountId: 'account' }] as MailThread[];
  const messages = [{ item_id: 'meeting', is_read: true }] as MailMessage[];
  const key = [...MAIL_KEYS.threads('account', 'inbox'), 50, 0];
  const otherKey = [...MAIL_KEYS.threads('other-account', 'inbox'), 50, 0];
  const searchKey = MAIL_KEYS.search('account', 'invitation');
  client.setQueryData(key, rows);
  client.setQueryData(otherKey, rows);
  client.setQueryData(searchKey, rows);
  let displayed!: MailThread[];
  function Harness({ selected, loading = false }: { selected: boolean; loading?: boolean }) {
    const [threads, setThreads] = useState(rows);
    displayed = threads;
    useMailThreadReadSync(setThreads, 'account', 'inbox', true);
    useMailConversationReadSync('account', 'inbox', selected ? 'invitation' : undefined, messages, loading, rows);
    return null;
  }
  const render = (selected: boolean, loading = false) => act(async () => {
    root.render(<QueryClientProvider client={client}><Harness selected={selected} loading={loading} /></QueryClientProvider>);
  });
  try {
    await render(true, true);
    expect(client.getQueryData(key)).toEqual(rows);
    await render(true);
    expect(displayed[0].unread_count).toBe(0);
    expect(client.getQueryData(key)).toEqual([{ ...rows[0], unread_count: 0 }]);
    expect(client.getQueryData(searchKey)).toEqual([{ ...rows[0], unread_count: 0 }]);
    expect(client.getQueryData(otherKey)).toEqual(rows);
    await render(false);
    expect(displayed[0].unread_count).toBe(0);
  } finally {
    await act(async () => root.unmount());
    client.clear();
  }
});

it('refreshes changed open conversations without clearing unread arrivals from stale detail', async () => {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const root = createRoot(document.createElement('div'));
  const key = [...MAIL_KEYS.threads('account', 'inbox'), 50, 0];
  const oldMessage = { item_id: 'old', is_read: true, date_time_received: '2026-10-25T10:00:00Z' } as MailMessage;
  const incoming = (id: string) => ({ ...oldMessage, item_id: id, is_read: false, date_time_received: '2026-10-26T10:00:00Z' });
  function Harness({ rows, messages }: { rows: MailThread[]; messages: MailMessage[] }) {
    useMailConversationRefresh('account', 'thread', rows, messages);
    useMailConversationReadSync('account', 'inbox', 'thread', messages, false, rows);
    return null;
  }
  const render = async (count: number, unread: number, messages: MailMessage[]) => {
    const rows = [{ conversation_id: 'thread', message_count: count, unread_count: unread, last_delivery_time: count === 1 ? oldMessage.date_time_received : incoming('1').date_time_received }] as MailThread[];
    client.setQueryData(key, rows);
    await act(async () => root.render(<QueryClientProvider client={client}><Harness rows={rows} messages={messages} /></QueryClientProvider>));
  };
  try {
    await render(1, 0, [oldMessage]);
    expect(invalidate).not.toHaveBeenCalled();
    await render(3, 2, [oldMessage]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: MAIL_KEYS.thread('account', 'thread') });
    expect((client.getQueryData(key) as MailThread[])[0].unread_count).toBe(2);
    await render(3, 2, [oldMessage, incoming('1'), incoming('2')]);
    await render(3, 2, [oldMessage, { ...incoming('1'), is_read: true }, incoming('2')]);
    expect((client.getQueryData(key) as MailThread[])[0].unread_count).toBe(1);
    await render(3, 1, [oldMessage, { ...incoming('1'), is_read: true }, { ...incoming('2'), is_read: true }]);
    expect((client.getQueryData(key) as MailThread[])[0].unread_count).toBe(0);
    expect(invalidate).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    client.clear();
  }
});
