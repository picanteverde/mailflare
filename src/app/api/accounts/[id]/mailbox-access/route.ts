import { NextResponse } from "next/server";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { applyGrantChanges, listGrantsForAccount } from "@/lib/mailboxes/grants";
import { accountGrantsSchema } from "@/lib/validators";
import { accountErrorResponse, requireTeamAdmin } from "../../utils";
import type { AccountRouteParams } from "../types";

/** picanteverde fork: every mailbox with this account's receive/send grant. Admin only. */
export async function GET(request: Request, { params }: AccountRouteParams) {
	const access = await requireTeamAdmin(request);
	if (access.error) return access.error;
	const { id } = await params;
	try {
		return NextResponse.json({ mailboxes: await listGrantsForAccount(access.env, access.user!.id, id) });
	} catch (error) {
		return accountErrorResponse(error);
	}
}

/** picanteverde fork: set receive/send on many mailboxes for this account, atomically and audited. */
export async function PUT(request: Request, { params }: AccountRouteParams) {
	const access = await requireTeamAdmin(request);
	if (access.error) return access.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const { id } = await params;
	const parsed = accountGrantsSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	try {
		return NextResponse.json(await applyGrantChanges(access.env, access.user!.id, parsed.data.grants.map((grant) => ({ userId: id, ...grant }))));
	} catch (error) {
		return accountErrorResponse(error);
	}
}
