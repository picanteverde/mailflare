import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { newId } from "@/lib/ids";
import { domains, mailboxAccess, mailboxes, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import type { MailboxAccessLevel, MailboxAction, MailboxPermission } from "./types";

/*
 * picanteverde fork: the single access rule (docs/picanteverde-access.md §1).
 *
 * - Access comes only from a mailbox_access grant: can_receive and can_send.
 *   Owning a mailbox (mailboxes.user_id), its `type` and the license grant nothing.
 * - The legacy `permission` column is never read.
 * - A disabled account or a disabled mailbox has no access, whatever the grant says.
 * - Admins manage mailboxes (`admin`) but get no mail access without a grant.
 * - Every call reads the database; nothing is cached, so a revoked grant applies
 *   on the next request.
 */

/** Only the id is used; role and disabled are re-read from the database on every call. */
type Principal = Pick<SessionUser, "id"> & Partial<Pick<SessionUser, "role" | "email">>;

type GrantRow = {
	mailbox: typeof mailboxes.$inferSelect;
	accountDisabled: boolean;
	role: SessionUser["role"];
	canReceive: boolean | null;
	canSend: boolean | null;
};

async function loadGrant(db: AppDatabase, user: Principal, mailboxId: string): Promise<GrantRow | null> {
	const [row] = await db
		.select({
			mailbox: mailboxes,
			accountDisabled: users.disabled,
			role: users.role,
			canReceive: mailboxAccess.canReceive,
			canSend: mailboxAccess.canSend,
		})
		.from(mailboxes)
		.innerJoin(users, eq(users.id, user.id))
		.leftJoin(mailboxAccess, and(eq(mailboxAccess.mailboxId, mailboxes.id), eq(mailboxAccess.userId, user.id)))
		.where(eq(mailboxes.id, mailboxId))
		.limit(1);
	return row ?? null;
}

function decide(row: GrantRow | null, action: MailboxAction): boolean {
	if (!row || row.accountDisabled) return false;
	if (action === "admin") return row.role === "admin";
	if (row.mailbox.disabled) return false;
	const receive = row.canReceive === true;
	if (action === "receive") return receive;
	return receive && row.canSend === true;
}

/** Default deny: true only when the account may perform `action` on the mailbox right now. */
export async function can(db: AppDatabase, user: Principal, mailboxId: string, action: MailboxAction): Promise<boolean> {
	return decide(await loadGrant(db, user, mailboxId), action);
}

/**
 * The caller's access to one mailbox, or null when they may not receive from it,
 * so routes answer 404 exactly as for a missing mailbox (§6).
 */
export async function getMailboxAccessLevel(
	db: AppDatabase,
	user: Principal,
	mailboxId: string,
): Promise<MailboxAccessLevel | null> {
	const row = await loadGrant(db, user, mailboxId);
	if (!decide(row, "receive") || !row) return null;
	const canSend = decide(row, "send");
	return {
		mailbox: row.mailbox,
		permission: grantLabel(canSend),
		isOwner: false,
		canRead: true,
		canOrganize: true,
		canSend,
		// Upstream reads canSendOnBehalf as "may send at all" and canSendAs as "sends as
		// the mailbox". With one send grant both equal canSend, so every send goes out
		// as the mailbox; the "X on behalf of Y" path is never taken.
		canSendAs: canSend,
		canSendOnBehalf: canSend,
		canManage: decide(row, "admin"),
	};
}

/** Mailboxes the account may receive from (or send from, with `action: "send"`), enabled ones only. */
export async function listAccessibleMailboxes(
	db: AppDatabase,
	user: Pick<SessionUser, "id" | "email">,
	action: Exclude<MailboxAction, "admin"> = "receive",
) {
	const rows = await db
		.select({
			id: mailboxes.id,
			userId: mailboxes.userId,
			domainId: mailboxes.domainId,
			localPart: mailboxes.localPart,
			displayName: mailboxes.displayName,
			signature: mailboxes.signature,
			autoReplyEnabled: mailboxes.autoReplyEnabled,
			autoReplySubject: mailboxes.autoReplySubject,
			autoReplyBody: mailboxes.autoReplyBody,
			useAllDomains: mailboxes.useAllDomains,
			avatarKey: mailboxes.avatarKey,
			type: mailboxes.type,
			disabled: mailboxes.disabled,
			createdAt: mailboxes.createdAt,
			hostname: domains.hostname,
			canSend: mailboxAccess.canSend,
		})
		.from(mailboxAccess)
		.innerJoin(users, eq(users.id, mailboxAccess.userId))
		.innerJoin(mailboxes, eq(mailboxAccess.mailboxId, mailboxes.id))
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.where(
			and(
				eq(mailboxAccess.userId, user.id),
				eq(mailboxAccess.canReceive, true),
				...(action === "send" ? [eq(mailboxAccess.canSend, true)] : []),
				eq(users.disabled, false),
				eq(mailboxes.disabled, false),
			),
		);
	return rows.map((row) => {
		const { avatarKey, ...mailbox } = row;
		return {
			...mailbox,
			hasAvatar: !!avatarKey,
			permission: grantLabel(row.canSend),
			isPrimary: `${row.localPart}@${row.hostname}` === user.email,
		};
	});
}

export async function listAccessibleMailboxIds(
	db: AppDatabase,
	user: Pick<SessionUser, "id" | "email">,
	action: Exclude<MailboxAction, "admin"> = "receive",
) {
	const rows = await listAccessibleMailboxes(db, user, action);
	return rows.map((row) => row.id);
}

/**
 * For bulk and agent loops: load the account's grants once per request, then check
 * each mailbox in memory. Build a new one per request; never keep it across requests.
 */
export async function loadMailboxGrants(db: AppDatabase, user: Pick<SessionUser, "id" | "email">) {
	const rows = await listAccessibleMailboxes(db, user);
	const receive = new Set(rows.map((row) => row.id));
	const send = new Set(rows.filter((row) => row.canSend).map((row) => row.id));
	return {
		can(mailboxId: string, action: Exclude<MailboxAction, "admin">) {
			return action === "send" ? send.has(mailboxId) : receive.has(mailboxId);
		},
		receive,
		send,
	};
}

/** Display label kept for the existing UI; derived from the grant, never read from `permission`. */
function grantLabel(canSend: boolean | null): MailboxPermission {
	return canSend ? "send_as" : "read_only";
}

/**
 * Interim (until the Phase 5 admin grants API): the account a mailbox is created for
 * gets receive+send on it, which keeps today's behaviour now that ownership alone
 * grants nothing. Insert it next to the mailbox row.
 */
export function creatorGrant(mailboxId: string, userId: string, grantedByUserId: string | null = null) {
	const now = new Date();
	return {
		id: newId("mac"),
		mailboxId,
		userId,
		canReceive: true,
		canSend: true,
		permission: "full_access" as const,
		createdByUserId: grantedByUserId,
		grantedByUserId,
		grantedAt: now,
		createdAt: now,
	};
}
