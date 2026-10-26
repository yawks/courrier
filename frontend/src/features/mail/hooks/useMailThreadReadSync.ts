import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Folder, MailMessage, MailThread } from '../types';
import { MAIL_KEYS } from './useMailQueries';

function isDetailBehind(thread: MailThread, messages: MailMessage[]) {
  return thread.message_count > messages.length
    || Date.parse(thread.last_delivery_time) > Math.max(...messages.map(message => Date.parse(message.date_time_received)));
}

/** List polling and push updates must also refresh the currently open detail. */
export function useMailConversationRefresh(accountId: string, conversationId: string | undefined, rows: MailThread[], messages: MailMessage[]) {
  const queryClient = useQueryClient();
  const previous = useRef<{ key: string; revision: string }>();
  const listed = rows.find(row => row.conversation_id === conversationId
    && (!row.accountId || row.accountId === accountId));
  const revision = listed ? JSON.stringify([listed.message_count, listed.last_delivery_time]) : undefined;
  useEffect(() => {
    if (!conversationId) { previous.current = undefined; return; }
    if (!revision) return;
    const key = JSON.stringify([accountId, conversationId]);
    if ((previous.current?.key === key && previous.current.revision !== revision)
      || (previous.current?.key !== key && listed && messages.length > 0 && isDetailBehind(listed, messages))) {
      void queryClient.invalidateQueries({ queryKey: MAIL_KEYS.thread(accountId, conversationId) });
    }
    previous.current = { key, revision };
  }, [queryClient, accountId, conversationId, revision, listed, messages]);
}

export function useMailConversationReadSync(
  accountId: string,
  folder: Folder,
  conversationId: string | undefined,
  messages: MailMessage[],
  loading: boolean,
  rows: MailThread[],
) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!conversationId || loading || messages.length === 0) return;
    const listed = rows.find(row => row.conversation_id === conversationId
      && (!row.accountId || row.accountId === accountId));
    // The list can receive the new envelope before the detail has reloaded.
    // Its older messages must not erase the newly reported unread state.
    if (listed && isDetailBehind(listed, messages)) return;
    const unreadCount = messages.filter(message => !message.is_read).length;
    // Persist the item-level state: EWS conversation aggregates can lag behind it.
    const update = (previous: MailThread[] | undefined) => previous?.map(thread =>
      thread.conversation_id === conversationId && thread.unread_count !== unreadCount
        ? { ...thread, unread_count: unreadCount }
        : thread,
    );
    for (const queryKey of [MAIL_KEYS.threads(accountId, folder), ['mail', accountId, 'search']]) {
      for (const [key, data] of queryClient.getQueriesData<MailThread[]>({ queryKey })) {
        if (data?.some(thread => thread.conversation_id === conversationId && thread.unread_count !== unreadCount)) {
          queryClient.setQueryData<MailThread[]>(key, update);
        }
      }
    }
  }, [queryClient, accountId, folder, conversationId, messages, loading, rows]);
}

export function useMailThreadReadSync(
  setThreads: Dispatch<SetStateAction<MailThread[]>>,
  selectedAccountId: string,
  selectedFolder: Folder,
  isAllMode: boolean,
) {
  const queryClient = useQueryClient();
  // Earlier pages are no longer observed by useQuery after loading the next page.
  useEffect(() => queryClient.getQueryCache().subscribe(event => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    const [scope, accountId, kind, folder] = event.query.queryKey;
    if (scope !== 'mail' || kind !== 'threads' || folder !== selectedFolder) return;
    if (!isAllMode && accountId !== selectedAccountId) return;
    const rows = event.query.state.data as MailThread[] | undefined;
    if (!Array.isArray(rows)) return;
    const updates = new Map(rows.map(row => [row.conversation_id, row]));
    setThreads(previous => {
      let changed = false;
      const next = previous.map(thread => {
        if ((thread.accountId ?? selectedAccountId) !== accountId) return thread;
        const update = updates.get(thread.conversation_id);
        if (!update || update.unread_count === thread.unread_count) return thread;
        changed = true;
        return { ...thread, unread_count: update.unread_count };
      });
      return changed ? next : previous;
    });
  }), [queryClient, setThreads, selectedAccountId, selectedFolder, isAllMode]);
}
