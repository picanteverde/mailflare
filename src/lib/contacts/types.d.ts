import type { contacts } from "@/db/schema";
import type { ContactSource } from "@/lib/email/address-types";

export type ContactRow = typeof contacts.$inferSelect;

export type ContactInput = {
	/** The mailbox's technical owner (contacts.user_id, NOT NULL). Never used for lookups. */
	userId: string;
	/** picanteverde fork: the mailbox the contact belongs to; every lookup is scoped by it. */
	mailboxId: string;
	address: string;
	source: ContactSource;
};

export type BlockContactInput = {
	userId: string;
	mailboxId: string;
	domainId: string;
	address: string;
};

export type MessageContactNames = {
	fromContactName: string | null;
	toContactName: string | null;
};
