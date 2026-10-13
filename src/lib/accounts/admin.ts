import { and, count, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { loginChallenges, mfaRecoveryCodes, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { revokeAllAccess } from "@/lib/auth/session";
import { newId } from "@/lib/ids";
import { createAuditLog } from "@/lib/mailboxes/audit";

/*
 * picanteverde fork: account administration (access design §1, §4, §7).
 *
 * - An account is a login only; creating one creates no mailbox. Mail access comes from grants.
 * - Admin is all-or-nothing: any enabled admin manages plain accounts. Admin accounts and
 *   roles are managed by the primary admin only (upstream rule, kept).
 * - The primary admin can't be disabled or demoted (transfer primary first), and the last
 *   enabled admin can't be disabled or demoted.
 * - Disable, password reset, TOTP reset and "revoke sessions" end every session, API key and
 *   realtime socket of the account (revokeAllAccess).
 * - Every admin action writes exactly one audit row. Roles and flags are always re-read from
 *   the database, never taken from the caller's session object.
 */

export class AccountAdminError extends Error {
	constructor(message: string, readonly status: number, readonly code: string) {
		super(message);
	}
}

export type ManagedAccountPatch = {
	name?: string;
	role?: "admin" | "user";
	disabled?: boolean;
	password?: string | null;
	forwardingEmail?: string | null;
};

export const MIN_ADMIN_SET_PASSWORD = 12;
const LOGIN_PATTERN = /^(?:[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|[a-z0-9][a-z0-9._-]{2,63})$/;

type Db = ReturnType<typeof getDb>;
type Account = typeof users.$inferSelect;

async function loadAccount(db: Db, id: string): Promise<Account | null> {
	const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
	return row ?? null;
}

async function requireActor(db: Db, actorId: string): Promise<Account> {
	const actor = await loadAccount(db, actorId);
	if (!actor || actor.disabled || actor.role !== "admin") throw new AccountAdminError("Forbidden", 403, "forbidden");
	return actor;
}

async function requireTarget(db: Db, actor: Account, targetId: string): Promise<Account> {
	const target = await loadAccount(db, targetId);
	if (!target) throw new AccountAdminError("Account not found", 404, "not_found");
	if ((target.role === "admin" || target.isPrimaryAdmin) && !actor.isPrimaryAdmin && target.id !== actor.id) {
		throw new AccountAdminError("Only the primary admin can manage admin accounts", 403, "primary_only");
	}
	return target;
}

async function otherEnabledAdmins(db: Db, targetId: string): Promise<number> {
	const [row] = await db
		.select({ n: count() })
		.from(users)
		.where(and(eq(users.role, "admin"), eq(users.disabled, false), ne(users.id, targetId)));
	return row?.n ?? 0;
}

/** A login is an email address on any domain, or a plain username. Lowercased. */
export function normalizeLogin(value: string): string | null {
	const login = value.trim().toLowerCase();
	return LOGIN_PATTERN.test(login) ? login : null;
}

export async function createLoginAccount(
	env: CloudflareEnv,
	actorId: string,
	input: { login: string; name?: string; password: string; role: "admin" | "user" },
) {
	const db = getDb(env);
	const actor = await requireActor(db, actorId);
	if (input.role === "admin" && !actor.isPrimaryAdmin) {
		throw new AccountAdminError("Only the primary admin can create admin accounts", 403, "primary_only");
	}
	const login = normalizeLogin(input.login);
	if (!login) throw new AccountAdminError("Use an email address or a username of 3-64 letters, digits, dots, dashes or underscores", 400, "invalid_login");
	if (input.password.length < MIN_ADMIN_SET_PASSWORD) {
		throw new AccountAdminError(`Passwords need at least ${MIN_ADMIN_SET_PASSWORD} characters`, 400, "weak_password");
	}
	const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, login)).limit(1);
	if (existing) throw new AccountAdminError("An account with this login already exists", 409, "login_taken");

	const id = newId("usr");
	const [account] = await db.insert(users).values({
		id,
		email: login,
		passwordHash: hashPassword(input.password),
		name: input.name?.trim() || login.split("@")[0]!,
		role: input.role,
		createdByUserId: actor.id,
	}).returning();
	await createAuditLog(env, { actorUserId: actor.id, targetUserId: id, action: "account.create", metadata: { login, role: input.role } });
	return account!;
}

export async function updateManagedAccount(env: CloudflareEnv, actorId: string, targetId: string, patch: ManagedAccountPatch) {
	const db = getDb(env);
	const actor = await requireActor(db, actorId);
	const target = await requireTarget(db, actor, targetId);
	const targetIsAdmin = target.role === "admin";

	const roleChange = patch.role !== undefined && patch.role !== target.role;
	const disableChange = patch.disabled !== undefined && patch.disabled !== target.disabled;
	if (roleChange && !actor.isPrimaryAdmin) throw new AccountAdminError("Only the primary admin can change roles", 403, "primary_only");
	const losesAdmin = targetIsAdmin && !target.disabled && ((roleChange && patch.role === "user") || (disableChange && patch.disabled));
	if (losesAdmin && target.isPrimaryAdmin) {
		throw new AccountAdminError("Transfer the primary admin role before disabling or demoting this account", 409, "primary_admin");
	}
	if (losesAdmin && (await otherEnabledAdmins(db, target.id)) === 0) {
		throw new AccountAdminError("This is the last enabled admin", 409, "last_admin");
	}
	if (patch.password && patch.password.length < MIN_ADMIN_SET_PASSWORD) {
		throw new AccountAdminError(`Passwords need at least ${MIN_ADMIN_SET_PASSWORD} characters`, 400, "weak_password");
	}

	const fields: string[] = [];
	const set: Partial<Account> = {};
	if (patch.name !== undefined && patch.name.trim() && patch.name.trim() !== target.name) {
		set.name = patch.name.trim();
		fields.push("name");
	}
	if (patch.forwardingEmail !== undefined && patch.forwardingEmail !== target.forwardingEmail) {
		set.forwardingEmail = patch.forwardingEmail;
		fields.push("forwardingEmail");
	}
	if (roleChange) set.role = patch.role;
	if (disableChange) set.disabled = patch.disabled;
	if (patch.password) set.passwordHash = hashPassword(patch.password);
	if (Object.keys(set).length > 0) await db.update(users).set(set).where(eq(users.id, target.id));

	const audit = (action: string, metadata?: Record<string, unknown>) =>
		createAuditLog(env, { actorUserId: actor.id, targetUserId: target.id, action, metadata });
	if (fields.length) await audit("account.update", { fields });
	if (roleChange) await audit("account.role_change", { from: target.role, to: patch.role });
	if (disableChange) await audit(patch.disabled ? "account.disable" : "account.enable");
	if (patch.password) await audit("credentials.password_reset", { by_admin: true, target_is_admin: targetIsAdmin });
	// Disabling or setting a password ends everything the account has open, keys included.
	if ((disableChange && patch.disabled) || patch.password) await revokeAllAccess(env, target.id);
	return (await loadAccount(db, target.id))!;
}

export async function revokeAccountSessions(env: CloudflareEnv, actorId: string, targetId: string) {
	const db = getDb(env);
	const actor = await requireActor(db, actorId);
	const target = await requireTarget(db, actor, targetId);
	const revoked = await revokeAllAccess(env, target.id);
	await createAuditLog(env, { actorUserId: actor.id, targetUserId: target.id, action: "session.revoke", metadata: { count: revoked } });
	return { revoked };
}

/** Clears the authenticator; the account must enroll again at its next sign-in (TOTP is mandatory). */
export async function resetAccountTotp(env: CloudflareEnv, actorId: string, targetId: string) {
	const db = getDb(env);
	const actor = await requireActor(db, actorId);
	const target = await requireTarget(db, actor, targetId);
	await db.update(users).set({ totpSecret: null, totpEnabled: false, totpConfirmedAt: null }).where(eq(users.id, target.id));
	await db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, target.id));
	await db.delete(loginChallenges).where(eq(loginChallenges.userId, target.id));
	await revokeAllAccess(env, target.id);
	await createAuditLog(env, { actorUserId: actor.id, targetUserId: target.id, action: "credentials.totp_reset", metadata: { target_is_admin: target.role === "admin" } });
	return { ok: true };
}
