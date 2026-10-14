import { and, count, eq, isNull, lte, or } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { messages } from "@/db/schema";
import { listAccessibleMailboxIds, mailboxScope } from "@/lib/mailboxes/access";
import type { SessionUser } from "@/lib/auth/types";

/**
 * picanteverde fork: the app-icon badge. Unread inbox mail summed over every mailbox the
 * account may receive from right now (enabled accounts and mailboxes only), with the same
 * inbox definition as /api/messages/counts: inbound, received, no folder, not snoozed.
 * Drafts, sent, archived, spam and trash never count.
 */
export async function countInboxUnread(db: AppDatabase, user: Pick<SessionUser, "id" | "email">, now = new Date()): Promise<number> {
	const mailboxIds = await listAccessibleMailboxIds(db, user, "receive");
	if (mailboxIds.length === 0) return 0;
	const [row] = await db
		.select({ total: count() })
		.from(messages)
		.where(
			and(
				mailboxScope(messages.mailboxId, mailboxIds),
				eq(messages.direction, "inbound"),
				eq(messages.status, "received"),
				isNull(messages.folderId),
				eq(messages.read, false),
				or(isNull(messages.snoozedUntil), lte(messages.snoozedUntil, now)),
			),
		);
	return row?.total ?? 0;
}
