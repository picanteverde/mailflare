import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import type { getDb } from "@/db";
import { domains, mailboxes, users } from "@/db/schema";
import { assertAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/cookies";
import { getLicenseEntitlements } from "@/lib/licenses/service";
import { getEnv } from "@/lib/cloudflare";
import { AccountAdminError } from "@/lib/accounts/admin";

type Db = ReturnType<typeof getDb>;

export function listAccountsForAdmin(db: Db) {
	return db
		.select({
			id: users.id,
			email: users.email,
			name: users.name,
			resetEmail: users.resetEmail,
			role: users.role,
			isPrimaryAdmin: users.isPrimaryAdmin,
			disabled: users.disabled,
			avatarKey: users.avatarKey,
			canManageMailboxes: users.canManageMailboxes,
			canManageDomains: users.canManageDomains,
			canManageUsers: users.canManageUsers,
			createdAt: users.createdAt,
		})
		.from(users)
		.orderBy(desc(users.createdAt));
}

export async function getDomainForAdmin(db: Db, adminUserId: string, domainId: string) {
	const [domain] = await db
		.select()
		.from(domains)
		.where(and(eq(domains.id, domainId), eq(domains.userId, adminUserId)))
		.limit(1);
	return domain ?? null;
}

export async function getExistingMailbox(db: Db, domainId: string, localPart: string) {
	const [mailbox] = await db
		.select()
		.from(mailboxes)
		.where(and(eq(mailboxes.domainId, domainId), eq(mailboxes.localPart, localPart)))
		.limit(1);
	return mailbox ?? null;
}

export function accountListItemFromUser(user: {
	id: string;
	email: string;
	name: string;
	resetEmail: string | null;
	role: "admin" | "user";
	isPrimaryAdmin?: boolean;
	disabled: boolean;
	avatarKey?: string | null;
	canManageMailboxes?: boolean;
	canManageDomains?: boolean;
	canManageUsers?: boolean;
	createdAt: Date;
}) {
	return {
		id: user.id,
		email: user.email,
		name: user.name,
		resetEmail: user.resetEmail,
		role: user.role,
		isPrimaryAdmin: !!user.isPrimaryAdmin,
		disabled: user.disabled,
		hasAvatar: !!user.avatarKey,
		canManageMailboxes: !!user.canManageMailboxes,
		canManageDomains: !!user.canManageDomains,
		canManageUsers: !!user.canManageUsers,
		createdAt: user.createdAt,
	};
}

/** picanteverde fork: maps AccountAdminError to its status and code; anything else is a 500. */
export function accountErrorResponse(error: unknown) {
	if (error instanceof AccountAdminError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
	throw error;
}

/** picanteverde fork: any enabled admin session; no license or seat gate. */
export async function requireTeamAdmin(request: Request) {
	const env = getEnv();
	try {
		const user = await requireUser(env, request);
		assertAdmin(user);
		return { env, user, error: null };
	} catch {
		return { env, user: null, error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
	}
}
