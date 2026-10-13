import { and, eq, gt, ne } from "drizzle-orm";
import { newId } from "@/lib/ids";
import { getDb } from "@/db";
import { sessions, users } from "@/db/schema";

export const SESSION_COOKIE = "ep_session";
const SESSION_DAYS = 30;

export function generateSessionToken(): string {
	return newId("sess");
}

export async function hashSessionToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export async function createSession(env: CloudflareEnv, userId: string): Promise<string> {
	const db = getDb(env);
	const token = generateSessionToken();
	const tokenHash = await hashSessionToken(token);
	const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);

	await db.insert(sessions).values({
		id: newId(),
		userId,
		tokenHash,
		expiresAt,
	});

	return token;
}

export async function getUserFromSession(
	env: CloudflareEnv,
	token: string | undefined,
): Promise<typeof users.$inferSelect | null> {
	const session = await getSessionFromToken(env, token);
	if (!session) return null;
	const db = getDb(env);
	const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
	// picanteverde fork: a session from before the last revocation is dead even if a row survived.
	if (user && isRevokedAt(user.sessionsRevokedAt, session.createdAt)) return null;
	return user ?? null;
}

export async function getSessionFromToken(
	env: CloudflareEnv,
	token: string | undefined,
): Promise<typeof sessions.$inferSelect | null> {
	if (!token) return null;
	const db = getDb(env);
	const tokenHash = await hashSessionToken(token);
	const [session] = await db
		.select()
		.from(sessions)
		.where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
		.limit(1);
	return session ?? null;
}

export async function deleteSession(env: CloudflareEnv, token: string): Promise<void> {
	const db = getDb(env);
	const tokenHash = await hashSessionToken(token);
	await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

/**
 * Sign the user out everywhere, optionally keeping the session that made the
 * request. Used after a password change or reset and when MFA is switched on.
 */
export async function deleteUserSessions(env: CloudflareEnv, userId: string, keepToken?: string): Promise<void> {
	const db = getDb(env);
	if (keepToken) {
		const keepHash = await hashSessionToken(keepToken);
		await db.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.tokenHash, keepHash)));
		return;
	}
	await db.delete(sessions).where(eq(sessions.userId, userId));
}

/** True when something created at `createdAt` predates the account's last revocation. */
export function isRevokedAt(revokedAt: Date | null | undefined, createdAt: Date): boolean {
	return !!revokedAt && createdAt.getTime() <= revokedAt.getTime();
}

/**
 * picanteverde fork: end every session, API key and realtime socket the account has right
 * now (access design §4). Used by "revoke sessions", password reset, disable and TOTP reset.
 * Returns how many sessions were deleted.
 */
export async function revokeAllAccess(env: CloudflareEnv, userId: string): Promise<number> {
	const db = getDb(env);
	// The column holds unix seconds; with `<=` everything created in this second or earlier is dead.
	const now = new Date(Math.floor(Date.now() / 1000) * 1000);
	const deleted = await db.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id });
	await db.update(users).set({ sessionsRevokedAt: now }).where(eq(users.id, userId));
	if (env.REALTIME) {
		await env.REALTIME.getByName(userId).fetch("https://realtime/revoke", { method: "POST" }).catch(() => undefined);
	}
	return deleted.length;
}

/** The session token a request carries, from the Bearer header or the cookie. */
export function getSessionTokenFromRequestHeaders(request: Request): string | undefined {
	const authorization = request.headers.get("Authorization");
	if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim() || undefined;
	const cookie = request.headers.get("Cookie") ?? "";
	const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
	return match ? decodeURIComponent(match[1]) : undefined;
}
