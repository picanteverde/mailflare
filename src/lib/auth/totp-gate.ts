import { getSessionTokenFromRequestHeaders, getUserFromSession } from "@/lib/auth/session";

/*
 * picanteverde fork: TOTP is mandatory (access design §4). This runs in the Worker before any
 * route: a request carrying the session of an account that has not finished enrolling gets
 * 403 totp_enrollment_required on every /api route except signing in and out, enrollment, and
 * public pages. getCurrentUser() also treats such an account as signed out, so a route reached
 * any other way still denies.
 */
const OPEN_PREFIXES = [
	"/api/auth/", // login, logout, me, MFA verify, password reset, account switch
	"/api/setup/", // first run (WAF-blocked in production)
	"/api/inbound", // provider webhooks, not session based
	"/api/public/", // public booking pages
	"/api/shared-files/", // expiring public links
	"/api/drive/public/",
	"/api/branding", // logo and name on the sign-in and enrollment pages
	"/api/v1/", // API keys; key-auth requires an enrolled account itself
];
const OPEN_PATHS = new Set(["/api/settings/mfa", "/api/settings/mfa/enroll", "/api/settings/mfa/confirm", "/api/realtime"]);

export function isTotpGateExempt(pathname: string): boolean {
	return OPEN_PATHS.has(pathname) || OPEN_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** A 403 response when the request's session belongs to an account without TOTP, else null. */
export async function totpEnrollmentGate(env: CloudflareEnv, request: Request): Promise<Response | null> {
	const { pathname } = new URL(request.url);
	if (!pathname.startsWith("/api/") || isTotpGateExempt(pathname)) return null;
	const token = getSessionTokenFromRequestHeaders(request);
	if (!token) return null;
	const user = await getUserFromSession(env, token);
	if (!user || user.disabled || user.totpEnabled) return null;
	return Response.json({ error: "Set up two-factor authentication first", code: "totp_enrollment_required" }, { status: 403 });
}
