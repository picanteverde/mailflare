import { cookies } from "next/headers";
import { SESSION_COOKIE, getUserFromSession } from "@/lib/auth/session";

function getBearerToken(request?: Request): string | undefined {
	const authorization = request?.headers.get("Authorization");
	if (!authorization?.startsWith("Bearer ")) return undefined;
	const token = authorization.slice(7).trim();
	return token || undefined;
}

async function getSessionAccount(env: CloudflareEnv, request?: Request) {
	const bearerToken = getBearerToken(request);
	if (bearerToken) {
		const user = await getUserFromSession(env, bearerToken);
		return user?.disabled ? null : user;
	}

	const jar = await cookies();
	const token = jar.get(SESSION_COOKIE)?.value;
	const user = await getUserFromSession(env, token);
	return user?.disabled ? null : user;
}

/**
 * The signed-in account. picanteverde fork: TOTP is mandatory (access design §4), so an
 * account that has not finished enrolling counts as signed out here, on the server, for
 * every route. Only the enrollment routes and /api/auth/me use getCurrentUserForEnrollment.
 */
export async function getCurrentUser(env: CloudflareEnv, request?: Request) {
	const user = await getSessionAccount(env, request);
	return user?.totpEnabled ? user : null;
}

/** The session's account even before TOTP enrollment. Only for enrollment and /api/auth/me. */
export async function getCurrentUserForEnrollment(env: CloudflareEnv, request?: Request) {
	return getSessionAccount(env, request);
}

export async function requireUser(env: CloudflareEnv, request?: Request) {
	const user = await getCurrentUser(env, request);
	if (!user) throw new Error("Unauthorized");
	return user;
}
