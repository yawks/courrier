package com.courrier.app

// These foreground reads must not wait behind calendar synchronization, contact
// backfills or photos. Gmail uses HTTP in the WebView; CalDAV has no mail list.
// Keep writes on their existing executor: do not replay or reorder mutations.
internal fun isMailboxReadCommand(command: String): Boolean = command in mailboxReadCommands
internal fun isConfigSyncCommand(command: String): Boolean =
    command == "config_webdav_fetch" || command == "config_webdav_put"

private val mailboxReadCommands = setOf(
    "mail_list_threads", "mail_list_folders", "mail_get_thread_count", "mail_search_threads",
    "imap_list_threads", "imap_list_folders",
    "jmap_list_threads", "jmap_list_folders", "jmap_get_thread_count", "jmap_search_threads",
    "jmap_list_identities",
)
