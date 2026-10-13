import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { createUserAccountSchema } from "@/lib/validators";
import { createLoginAccount } from "@/lib/accounts/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { accountErrorResponse, accountListItemFromUser, listAccountsForAdmin, requireTeamAdmin } from "./utils";

export async function GET(request: Request) {
	const access = await requireTeamAdmin(request);
	if (access.error) return access.error;
	const rows = await listAccountsForAdmin(getDb(access.env));
	// picanteverde fork: no seat limit.
	return NextResponse.json({ accounts: rows.map((row) => accountListItemFromUser(row)), seats: null });
}

/** picanteverde fork: creates a login only (no mailbox); mailboxes are granted separately. */
export async function POST(request: Request) {
	const access = await requireTeamAdmin(request);
	if (access.error) return access.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = createUserAccountSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	try {
		const account = await createLoginAccount(access.env, access.user!.id, parsed.data);
		return NextResponse.json({ account: accountListItemFromUser(account) }, { status: 201 });
	} catch (error) {
		return accountErrorResponse(error);
	}
}
