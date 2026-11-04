// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mailCommand } = vi.hoisted(() => ({ mailCommand: vi.fn() }));

vi.mock('../../../shared/api/mailApi', () => ({ mailCommand }));

import { EwsMailProvider } from './EwsMailProvider';

describe('EwsMailProvider', () => {
  beforeEach(() => mailCommand.mockReset());

  for (const isForward of [false, true]) {
    for (const attachments of [[], [{ name: 'file.txt', contentType: 'text/plain', size: 4, data: 'dGVzdA==' }]]) {
      it(`refreshes a moved parent before sending (forward=${isForward}, attachments=${attachments.length})`, async () => {
        mailCommand.mockImplementation(async (command: string) => {
          if (command === 'mail_get_thread_headers') return [
            { item_id: 'other', change_key: 'other-key', message_id: '<other@example.com>' },
            { item_id: 'moved-parent', change_key: 'new-key', message_id: '<parent@example.com>' },
          ];
        });
        const provider = new EwsMailProvider('account', async () => 'token');
        await provider.sendMail({
          to: ['recipient@example.com'], subject: 'Reply', bodyHtml: '<p>Body</p>',
          conversationId: 'conversation', replyMessageId: '<parent@example.com>',
          replyToItemId: 'old-parent', replyToChangeKey: 'old-key', isForward, attachments,
        });
        expect(mailCommand).toHaveBeenNthCalledWith(1, 'mail_get_thread_headers', expect.objectContaining({
          conversationId: 'conversation', includeTrash: true,
        }));
        expect(mailCommand).toHaveBeenLastCalledWith('mail_send', expect.objectContaining({
          replyToItemId: 'moved-parent', replyToChangeKey: 'new-key', isForward, attachments,
        }));
      });
    }
  }

  it('refreshes the change key even if the item has not moved', async () => {
    mailCommand.mockResolvedValueOnce([{ item_id: 'parent', change_key: 'new-key' }]);
    const provider = new EwsMailProvider('account', async () => 'token');
    await provider.sendMail({ to: [], subject: 'Reply', bodyHtml: '', conversationId: 'conversation', replyToItemId: 'parent', replyToChangeKey: 'old-key' });
    expect(mailCommand).toHaveBeenLastCalledWith('mail_send', expect.objectContaining({ replyToItemId: 'parent', replyToChangeKey: 'new-key' }));
  });

  it('does not retry a send with an uncertain outcome', async () => {
    mailCommand.mockRejectedValueOnce(new Error('network timeout'));
    const provider = new EwsMailProvider('account', async () => 'token');
    await expect(provider.sendMail({ to: [], subject: 'New', bodyHtml: '' })).rejects.toThrow('network timeout');
    expect(mailCommand).toHaveBeenCalledOnce();
  });

  it('does not send when refreshing the reference fails', async () => {
    mailCommand.mockRejectedValueOnce(new Error('Exchange unavailable'));
    const provider = new EwsMailProvider('account', async () => 'token');
    await expect(provider.sendMail({ to: [], subject: 'Reply', bodyHtml: '', conversationId: 'conversation', replyToItemId: 'old-parent' })).rejects.toThrow('Exchange unavailable');
    expect(mailCommand).not.toHaveBeenCalledWith('mail_send', expect.anything());
  });

  it('moves each Exchange item once even when conversation envelopes repeat it', async () => {
    mailCommand.mockImplementation(async (command: string) => {
      if (command === 'mail_get_thread_headers') return [{ item_id: 'first' }, { item_id: 'first' }, { item_id: 'second' }];
    });
    const provider = new EwsMailProvider('account', async () => 'token');

    await provider.bulkMoveToFolder(['conversation', 'conversation'], 'archive-folder');

    expect(mailCommand).toHaveBeenCalledWith('mail_bulk_move_to_folder', {
      accessToken: 'token', itemIds: ['first', 'second'], folderId: 'archive-folder',
    });
    expect(mailCommand.mock.calls.filter(([command]) => command === 'mail_bulk_move_to_folder')).toHaveLength(1);
  });

  it('reports a header lookup failure instead of claiming the move succeeded', async () => {
    mailCommand.mockRejectedValueOnce(new Error('ErrorItemNotFound: Item not found.'));
    const provider = new EwsMailProvider('account', async () => 'token');

    await expect(provider.bulkMoveToFolder(['conversation'], 'archive-folder')).rejects.toThrow('ErrorItemNotFound');
    expect(mailCommand).not.toHaveBeenCalledWith('mail_bulk_move_to_folder', expect.anything());
  });

  it('counts draft items without an Exchange conversation operation', async () => {
    mailCommand.mockResolvedValueOnce([{ folder_id: 'drafts', total_count: 3 }]);
    const provider = new EwsMailProvider('account', async () => 'token');

    await expect(provider.getThreadCount('drafts')).resolves.toBe(3);
    expect(mailCommand).toHaveBeenCalledOnce();
    expect(mailCommand).toHaveBeenCalledWith('mail_list_folders', { accessToken: 'token' });
  });

  it('loads the complete draft before opening the editor', async () => {
    const draft = { item_id: 'draft-item', body_html: '<p>Saved draft text</p>', attachments: [{ id: 'attachment' }] };
    mailCommand.mockResolvedValueOnce([draft]);
    const provider = new EwsMailProvider('account', async () => 'token');

    const messages = await provider.getThread('draft-item', false, true);

    expect(mailCommand).toHaveBeenCalledOnce();
    expect(mailCommand).toHaveBeenCalledWith('mail_get_thread', {
      accessToken: 'token', conversationId: 'draft-item', includeTrash: false,
      isDraft: true, includeDrafts: false,
    });
    expect(messages).toEqual([{ ...draft, body_loaded: true }]);
  });

  it('loads thread envelopes without downloading every message body', async () => {
    mailCommand.mockResolvedValueOnce([
      { item_id: 'older', body_html: '', subject: 'Thread' },
      { item_id: 'newer', body_html: '', subject: 'Thread' },
    ]);
    const provider = new EwsMailProvider('account', async () => 'token');

    const messages = await provider.getThread('conversation', false, false, true);

    expect(mailCommand).toHaveBeenCalledWith('mail_get_thread_headers', {
      accessToken: 'token',
      conversationId: 'conversation',
      includeTrash: false,
      isDraft: false,
      includeDrafts: true,
    });
    expect(messages).toEqual([
      expect.objectContaining({ item_id: 'older', body_loaded: false }),
      expect.objectContaining({ item_id: 'newer', body_loaded: false }),
    ]);
  });
});
