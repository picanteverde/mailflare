import { NextResponse } from "next/server";
import { getCurrentUser, getCurrentUserForEnrollment } from "@/lib/auth/cookies";
import { authenticateApiKeyValue, hasScope } from "@/lib/api/key-auth";
import type { ApiAuthResult } from "@/lib/api/key-auth-types";

export type { ApiAuthResult };

export async function authenticateApiKey(
	env: CloudflareEnv,
	authorization: string | null,
): Promise<ApiAuthResult | null> {
	if (!authorization?.startsWith("Bearer ")) return null;
	return authenticateApiKeyValue(env, authorization.slice(7));
}

export const requireScope = hasScope;

/**
 * Session auth for route handlers. `requireUser` throws a bare Error, which Next turns into
 * a 500; this returns a proper 401 response instead so unauthenticated callers get the right
 * status.
 */
export async function requireSessionUser(env: CloudflareEnv, request: Request, options: { allowTotpEnrollment?: boolean } = {}) {
	const user = options.allowTotpEnrollment ? await getCurrentUserForEnrollment(env, request) : await getCurrentUser(env, request);
	if (!user) {
		// picanteverde fork: a signed-in account that still has to enroll TOTP gets a code the UI can act on.
		const pending = !options.allowTotpEnrollment && (await getCurrentUserForEnrollment(env, request));
		return pending
			? ({ user: null, error: NextResponse.json({ error: "Set up two-factor authentication first", code: "totp_enrollment_required" }, { status: 403 }) } as const)
			: ({ user: null, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const);
	}
	return { user, error: null } as const;
}
