package com.courrier.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MailboxReadCommandsTest {
    @Test fun configSyncCannotWaitBehindCalendarOrContactSync() {
        assertTrue(isConfigSyncCommand("config_webdav_fetch"))
        assertTrue(isConfigSyncCommand("config_webdav_put"))
        assertFalse(isConfigSyncCommand("exchange_calendar_list"))
        assertFalse(isConfigSyncCommand("calendar_caldav_query"))
        assertFalse(isConfigSyncCommand("mail_backfill_contacts"))
        assertFalse(isConfigSyncCommand("jmap_list_threads"))
    }
    @Test fun mailboxReadsHaveTheirOwnQueueForEveryNativeMailProvider() {
        for (command in listOf(
            "mail_list_threads", "mail_list_folders", "mail_get_thread_count", "mail_search_threads",
            "imap_list_threads", "imap_list_folders",
            "jmap_list_threads", "jmap_list_folders", "jmap_get_thread_count", "jmap_search_threads",
            "jmap_list_identities",
        )) assertTrue(command, isMailboxReadCommand(command))
    }

    @Test fun backgroundWorkAndMutationsNeverUseTheMailboxQueue() {
        for (command in listOf(
            "calendar_caldav_query", "exchange_calendar_list", "mail_backfill_contacts",
            "mail_get_contact_photo", "mail_send", "mail_delete", "mail_move_to_folder",
            "imap_send", "imap_delete", "jmap_send", "jmap_delete", "jmap_mark_read",
            "mail_get_thread", "jmap_get_message_content",
        )) assertFalse(command, isMailboxReadCommand(command))
    }
}
