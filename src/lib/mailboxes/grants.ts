import { and, asc, eq, inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "@/db";
import { auditLogs, domains, mailboxAccess, mailboxes, users } from "@/db/schema";
import { AccountAdminError } from "@/lib/accounts/admin";
import { newId } from "@/lib/ids";
import { notifyGrantsChanged } from "@/lib/realtime/utils";

/*
 * picanteverde fork: the admin grants API (access design §1, §7). Every grant change goes
 * through applyGrantChanges(): the actor is re-checked as an enabled admin in the database,
 * send needs receive, no-op changes are skipped, and each changed (account, mailbox) pair
 * writes exactly one grant.set or grant.revoke audit row with the previous value, all in one
 * atomic batch. An admin granting themselves is flagged `self: true` in the audit row.
 */

export type GrantChange = { userId: string; mailboxId: string; receive: boolean; send: boolean };

// Each change is two statements (grant + audit); 200 keeps a batch well inside D1 per-request limits.
export const MAX_GRANT_CHANGES = 200;

type Db = ReturnType<typeof getDb>;

// D1 binds at most 100 parameters per statement. The pair lookup binds two lists, so each
// list stays at 45 (two lists = 90).
const ID_CHUNK = 45;
function chunks<T>(items: T[]): T[][] {
	const out: T[][] = [];
	for (let index = 0; index < items.length; index += ID_CHUNK) out.push(items.slice(index, index + ID_CHUNK));
	return out;
}

async function requireAdminActor(db: Db, actorId: string) {
	const [actor] = await db.select({ id: users.id, role: users.role, disabled: users.disabled }).from(users).where(eq(users.id, actorId)).limit(1);
	if (!actor || actor.disabled || actor.role !== "admin") throw new AccountAdminError("Forbidden", 403, "forbidden");
	return actor;
}

/** Every mailbox, with the given account's grant on it (false/false when none). Admin only. */
export async function listGrantsForAccount(env: CloudflareEnv, actorId: string, userId: string) {
	const db = getDb(env);
	await requireAdminActor(db, actorId);
	const [account] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
	if (!account) throw new AccountAdminError("Account not found", 404, "not_found");
	const rows = await db
		.select({
			mailboxId: mailboxes.id,
			localPart: mailboxes.localPart,
			hostname: domains.hostname,
			displayName: mailboxes.displayName,
			disabled: mailboxes.disabled,
			receive: mailboxAccess.canReceive,
			send: mailboxAccess.canSend,
		})
		.from(mailboxes)
		.innerJoin(domains, eq(domains.id, mailboxes.domainId))
		.leftJoin(mailboxAccess, and(eq(mailboxAccess.mailboxId, mailboxes.id), eq(mailboxAccess.userId, userId)))
		.orderBy(asc(domains.hostname), asc(mailboxes.localPart));
	return rows.map((row) => ({ ...row, address: `${row.localPart}@${row.hostname}`, receive: !!row.receive, send: !!row.send }));
}

/** Every account, with its grant on the given mailbox (false/false when none). Admin only. */
export async function listGrantsForMailbox(env: CloudflareEnv, actorId: string, mailboxId: string) {
	const db = getDb(env);
	await requireAdminActor(db, actorId);
	const [mailbox] = await db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1);
	if (!mailbox) throw new AccountAdminError("Mailbox not found", 404, "not_found");
	const rows = await db
		.select({
			userId: users.id,
			email: users.email,
			name: users.name,
			role: users.role,
			disabled: users.disabled,
			receive: mailboxAccess.canReceive,
			send: mailboxAccess.canSend,
		})
		.from(users)
		.leftJoin(mailboxAccess, and(eq(mailboxAccess.userId, users.id), eq(mailboxAccess.mailboxId, mailboxId)))
		.orderBy(asc(users.email));
	return rows.map((row) => ({ ...row, receive: !!row.receive, send: !!row.send }));
}

export async function applyGrantChanges(env: CloudflareEnv, actorId: string, changes: GrantChange[]): Promise<{ changed: number }> {
	const db = getDb(env);
	const actor = await requireAdminActor(db, actorId);
	if (changes.length === 0) return { changed: 0 };
	if (changes.length > MAX_GRANT_CHANGES) throw new AccountAdminError(`At most ${MAX_GRANT_CHANGES} changes at once`, 400, "too_many");
	const seen = new Set<string>();
	for (const change of changes) {
		if (change.send && !change.receive) throw new AccountAdminError("Send needs receive", 400, "send_without_receive");
		const pair = `${change.userId}\u0000${change.mailboxId}`;
		if (seen.has(pair)) throw new AccountAdminError("Each account and mailbox pair may appear once", 400, "duplicate_pair");
		seen.add(pair);
	}

	const userIds = [...new Set(changes.map((change) => change.userId))];
	const mailboxIds = [...new Set(changes.map((change) => change.mailboxId))];
	const foundUsers = new Set<string>();
	for (const part of chunks(userIds)) for (const row of await db.select({ id: users.id }).from(users).where(inArray(users.id, part))) foundUsers.add(row.id);
	const foundMailboxes = new Set<string>();
	for (const part of chunks(mailboxIds)) for (const row of await db.select({ id: mailboxes.id }).from(mailboxes).where(inArray(mailboxes.id, part))) foundMailboxes.add(row.id);
	if (userIds.some((id) => !foundUsers.has(id))) throw new AccountAdminError("Account not found", 404, "not_found");
	if (mailboxIds.some((id) => !foundMailboxes.has(id))) throw new AccountAdminError("Mailbox not found", 404, "not_found");

	// Bulk changes are "one account x many mailboxes" or "many accounts x one mailbox", so one
	// side is small; page over the larger side.
	const [few, many, fewColumn, manyColumn] = userIds.length <= mailboxIds.length
		? [userIds, mailboxIds, mailboxAccess.userId, mailboxAccess.mailboxId]
		: [mailboxIds, userIds, mailboxAccess.mailboxId, mailboxAccess.userId];
	const existing: { id: string; userId: string; mailboxId: string; receive: boolean; send: boolean }[] = [];
	for (const fewPart of chunks(few)) {
		for (const manyPart of chunks(many)) {
			existing.push(...await db
				.select({ id: mailboxAccess.id, userId: mailboxAccess.userId, mailboxId: mailboxAccess.mailboxId, receive: mailboxAccess.canReceive, send: mailboxAccess.canSend })
				.from(mailboxAccess)
				.where(and(inArray(fewColumn, fewPart), inArray(manyColumn, manyPart))));
		}
	}
	const previousByPair = new Map(existing.map((row) => [`${row.userId}\u0000${row.mailboxId}`, row]));

	const now = new Date();
	const statements: BatchItem<"sqlite">[] = [];
	let changed = 0;
	const changedUserIds: string[] = [];
	for (const change of changes) {
		const previousRow = previousByPair.get(`${change.userId}\u0000${change.mailboxId}`);
		const previous = { receive: !!previousRow?.receive, send: !!previousRow?.send };
		if (previous.receive === change.receive && previous.send === change.send) continue;
		changed += 1;
		changedUserIds.push(change.userId);
		const self = change.userId === actor.id;
		if (!change.receive) {
			if (previousRow) statements.push(db.delete(mailboxAccess).where(eq(mailboxAccess.id, previousRow.id)));
		} else {
			const values = { canReceive: change.receive, canSend: change.send, grantedByUserId: actor.id, grantedAt: now };
			statements.push(
				db.insert(mailboxAccess)
					.values({ id: newId("mac"), mailboxId: change.mailboxId, userId: change.userId, permission: change.send ? "send_as" : "read_only", createdByUserId: actor.id, createdAt: now, ...values })
					.onConflictDoUpdate({ target: [mailboxAccess.mailboxId, mailboxAccess.userId], set: { ...values, permission: change.send ? "send_as" : "read_only" } }),
			);
		}
		statements.push(db.insert(auditLogs).values({
			id: newId("aud"),
			actorUserId: actor.id,
			targetUserId: change.userId,
			mailboxId: change.mailboxId,
			action: change.receive ? "grant.set" : "grant.revoke",
			metadata: JSON.stringify(change.receive ? { receive: change.receive, send: change.send, previous, self } : { previous, self }),
			createdAt: now,
		}));
	}
	if (statements.length === 0) return { changed: 0 };
	await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
	await notifyGrantsChanged(env, changedUserIds);
	return { changed };
}
