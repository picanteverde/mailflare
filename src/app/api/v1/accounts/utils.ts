import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { authenticateAdminApiKey } from "@/lib/api/admin-auth";
import { createLoginAccount } from "@/lib/accounts/admin";
import { createUserAccountSchema } from "@/lib/validators";
import { accountErrorResponse, accountListItemFromUser, listAccountsForAdmin } from "@/app/api/accounts/utils";

// picanteverde fork: no license gate; the same account service as the dashboard.
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "accounts");
	if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const rows = await listAccountsForAdmin(getDb(env));
	return NextResponse.json({ accounts: rows.map(accountListItemFromUser) });
}

export async function POST(request: Request) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "accounts");
	if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const parsed = createUserAccountSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	try {
		const account = await createLoginAccount(env, auth.userId, parsed.data);
		return NextResponse.json({ account: accountListItemFromUser(account) }, { status: 201 });
	} catch (error) {
		return accountErrorResponse(error);
	}
}
