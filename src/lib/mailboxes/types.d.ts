import type { mailboxes } from "@/db/schema";

export type MailboxPermission = "read_only" | "send_as" | "send_on_behalf" | "full_access";

export type MailboxType = "personal" | "shared";

/** picanteverde fork: what a grant allows (docs/picanteverde-access.md §2). */
export type MailboxAction = "receive" | "send" | "admin";

export type MailboxAccessLevel = {
	mailbox: typeof mailboxes.$inferSelect;
	permission: MailboxPermission;
	/** Always false in this fork: owning a mailbox grants nothing by itself. */
	isOwner: boolean;
	canRead: boolean;
	canOrganize: boolean;
	canSend: boolean;
	/** picanteverde fork: equal to canSend. */
	canSendAs: boolean;
	/** picanteverde fork: equal to canSend (upstream meaning: "may send at all"). */
	canSendOnBehalf: boolean;
	canManage: boolean;
};

export type AuditAction =
	| "auth.login"
	| "auth.logout"
	| "email.send"
	| "email.read"
	| "email.delete"
	/** picanteverde fork: archive, unarchive, trash, inbox or folder (nothing is destroyed). */
	| "email.move"
	| "permission.change"
	| "mailbox.access";

export type AuditLogInput = {
	actorUserId?: string | null;
	targetUserId?: string | null;
	mailboxId?: string | null;
	messageId?: string | null;
	action: AuditAction | string;
	metadata?: Record<string, unknown>;
};
