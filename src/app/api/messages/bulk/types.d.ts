/** picanteverde fork: "unarchive" undoes "archive" exactly: back to received, snooze kept. */
export type BulkMessageAction = "archive" | "unarchive" | "trash" | "spam" | "read" | "unread" | "inbox" | "folder" | "delete";

/** Folders whose messages can be permanently deleted or emptied in one go. */
export type PermanentDeleteFolder = "trash" | "spam";

export type BulkMessagePayload = {
	messageIds?: string[];
	action?: BulkMessageAction;
	folderId?: string;
};
