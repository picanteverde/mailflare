import { eq, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { loginBackoff } from "@/db/schema";

/*
 * picanteverde fork: sign-in backoff (access design §4). After FREE_FAILURES failed attempts
 * for a login from one client, each further attempt waits 1s, 2s, 4s ... up to MAX_DELAY_S.
 * The key includes the client IP, so failures from elsewhere never slow down the real user,
 * and nothing is ever locked. A success clears the key; a day of quiet forgets it. Unknown
 * logins get the same treatment, so the delay reveals nothing about which accounts exist.
 */
const FREE_FAILURES = 4;
const MAX_DELAY_S = 15 * 60;
const FORGET_AFTER_MS = 24 * 60 * 60 * 1000;

export type BackoffStep = "password" | "totp";

function clientIp(request: Request): string {
	return request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ?? "unknown";
}

async function backoffKey(step: BackoffStep, login: string, request: Request): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${step}|${login.trim().toLowerCase()}|${clientIp(request)}`));
	return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function backoffDelaySeconds(failures: number): number {
	if (failures < FREE_FAILURES) return 0;
	return Math.min(2 ** (failures - FREE_FAILURES), MAX_DELAY_S);
}

/** Seconds to wait before this attempt may be checked, or 0. Call before verifying anything. */
export async function backoffWait(env: CloudflareEnv, step: BackoffStep, login: string, request: Request, now = new Date()): Promise<number> {
	const [row] = await getDb(env).select().from(loginBackoff).where(eq(loginBackoff.key, await backoffKey(step, login, request))).limit(1);
	if (!row?.nextAllowedAt || now.getTime() - row.updatedAt.getTime() > FORGET_AFTER_MS) return 0;
	return Math.max(0, Math.ceil((row.nextAllowedAt.getTime() - now.getTime()) / 1000));
}

export async function recordBackoffFailure(env: CloudflareEnv, step: BackoffStep, login: string, request: Request, now = new Date()): Promise<void> {
	const db = getDb(env);
	const key = await backoffKey(step, login, request);
	const [row] = await db.select().from(loginBackoff).where(eq(loginBackoff.key, key)).limit(1);
	const stale = !row || now.getTime() - row.updatedAt.getTime() > FORGET_AFTER_MS;
	const failures = (stale ? 0 : row!.failures) + 1;
	const delay = backoffDelaySeconds(failures);
	const values = { failures, nextAllowedAt: delay ? new Date(now.getTime() + delay * 1000) : null, updatedAt: now };
	await db.insert(loginBackoff).values({ key, ...values }).onConflictDoUpdate({ target: loginBackoff.key, set: values });
	// Opportunistic cleanup keeps the table small.
	await db.delete(loginBackoff).where(lt(loginBackoff.updatedAt, new Date(now.getTime() - FORGET_AFTER_MS)));
}

export async function clearBackoff(env: CloudflareEnv, step: BackoffStep, login: string, request: Request): Promise<void> {
	await getDb(env).delete(loginBackoff).where(eq(loginBackoff.key, await backoffKey(step, login, request)));
}
