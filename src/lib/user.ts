import { eq, desc, and } from "drizzle-orm";
import { getDb } from "@/db";
import { messages, domains, mailboxes } from "@/db/schema";
import { getMailboxAccessLevel, listAccessibleMailboxIds } from "@/lib/mailboxes/access";
import { createAuditLog } from "@/lib/mailboxes/audit";
import type { SessionUser } from "@/lib/auth/types";
import { applySpamFeedback } from "@/lib/spam/feedback";

export async function userHasAccessibleMailboxes(env: CloudflareEnv, user: SessionUser): Promise<boolean> {
	const db = getDb(env);
	const ids = await listAccessibleMailboxIds(db, user);
	return ids.length > 0;
}

export async function hasPrimaryDomain(env: CloudflareEnv): Promise<boolean> {
	const db = getDb(env);
	const [row] = await db.select({ id: domains.id }).from(domains).limit(1);
	return !!row;
}

export async function getPrimaryDomain(env: CloudflareEnv) {
	const db = getDb(env);
	const [row] = await db.select().from(domains).limit(1);
	return row ?? null;
}

export async function markMessageAsReadForUser(env: CloudflareEnv, user: SessionUser, messageId: string) {
	const db = getDb(env);
	const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message?.mailboxId) return false;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return false;
	await db.update(messages).set({ read: true }).where(eq(messages.id, messageId));
	await createAuditLog(env, {
		actorUserId: user.id,
		mailboxId: message.mailboxId,
		messageId,
		action: "email.read",
	});
	return true;
}

export async function updateMessageStatusForUser(
	env: CloudflareEnv,
	user: SessionUser,
	messageId: string,
	status: string,
) {
	const db = getDb(env);
	const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message?.mailboxId) return false;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	// picanteverde fork: archive/trash/spam/inbox are organizing, which needs receive.
	if (!access?.canOrganize) return false;
	if (status === "spam") return applySpamFeedback(env, user, messageId, "spam");
	if (status === "received" && message.status === "spam") return applySpamFeedback(env, user, messageId, "ham");
	await db.update(messages).set({ status }).where(eq(messages.id, messageId));
	await createAuditLog(env, {
		actorUserId: user.id,
		mailboxId: message.mailboxId,
		messageId,
		action: "email.delete",
		metadata: { status },
	});
	return true;
}

