import { and, eq } from "drizzle-orm";
import type { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { getContactId } from "@/lib/contacts/utils";

type Db = ReturnType<typeof getDb>;

/** picanteverde fork: contacts are looked up in one mailbox only (0063). */
export async function getContactByEmail(db: Db, mailboxId: string, email: string) {
	const [contact] = await db
		.select()
		.from(contacts)
		.where(and(eq(contacts.mailboxId, mailboxId), eq(contacts.email, email)))
		.limit(1);
	return contact ?? null;
}

export function toContactDetails(contact: Awaited<ReturnType<typeof getContactByEmail>>) {
	if (!contact) return null;
	const { avatarKey, ...details } = contact;
	return { ...details, hasAvatar: !!avatarKey };
}

export async function saveManualContactName(
	db: Db,
	input: { userId: string; mailboxId: string; email: string; displayName: string },
) {
	const existing = await getContactByEmail(db, input.mailboxId, input.email);
	if (existing) {
		await db
			.update(contacts)
			.set({ displayName: input.displayName, source: "manual" })
			.where(eq(contacts.id, existing.id));
		return { ...existing, displayName: input.displayName, source: "manual" as const };
	}

	const id = getContactId(input.mailboxId, input.email);
	await db.insert(contacts).values({
		id,
		userId: input.userId,
		mailboxId: input.mailboxId,
		email: input.email,
		displayName: input.displayName,
		source: "manual",
	});
	return getContactByEmail(db, input.mailboxId, input.email);
}
