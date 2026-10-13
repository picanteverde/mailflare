import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { authenticateAdminApiKey } from "@/lib/api/admin-auth";
import { updateManagedAccount } from "@/lib/accounts/admin";
import { updateManagedAccountSchema } from "@/lib/validators";
import { getLicenseEntitlements } from "@/lib/licenses/service";
import { selectAccountById } from "@/app/api/accounts/[id]/utils";
import { accountErrorResponse } from "@/app/api/accounts/utils";
import type { AdminAccountRouteParams } from "./types";

// picanteverde fork: no license gate; the same account service as the dashboard.
export async function GET(request: Request, { params }: AdminAccountRouteParams) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "accounts");
	if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const { id } = await params;
	const account = await selectAccountById(getDb(env), id);
	if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 });
	return NextResponse.json({ account: {
		id: account.id, email: account.email, name: account.name, role: account.role,
		disabled: account.disabled, totpEnabled: account.totpEnabled,
		forwardingEmail: account.forwardingEmail, hasAvatar: !!account.avatarKey,
	} });
}

export async function PATCH(request: Request, { params }: AdminAccountRouteParams) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "accounts");
	if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const { id } = await params;
	const parsed = updateManagedAccountSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	if (!(await getLicenseEntitlements(env)).canForwardEmail && parsed.data.forwardingEmail) {
		return NextResponse.json({ error: "A Pro or Team license is required for email forwarding" }, { status: 403 });
	}
	try {
		await updateManagedAccount(env, auth.userId, id, {
			name: parsed.data.name,
			role: parsed.data.role,
			disabled: parsed.data.disabled,
			password: parsed.data.password,
			forwardingEmail: parsed.data.forwardingEmail,
		});
		return NextResponse.json({ ok: true });
	} catch (error) {
		return accountErrorResponse(error);
	}
}
