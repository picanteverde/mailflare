import { NextResponse } from "next/server";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { applyGrantChanges, listGrantsForMailbox } from "@/lib/mailboxes/grants";
import { mailboxGrantsSchema } from "@/lib/validators";
import { accountErrorResponse, requireTeamAdmin } from "@/app/api/accounts/utils";
import type { MailboxAccessRouteParams } from "./types";

/*
 * picanteverde fork: replaces the Team-licensed shared-inbox members route. Works for every
 * mailbox, takes receive/send instead of permission levels, and goes through the same
 * audited grants service as the account page.
 */

/** Every account with its receive/send grant on this mailbox. Admin only. */
export async function GET(request: Request, { params }: MailboxAccessRouteParams) {
	const access = await requireTeamAdmin(request);
	if (access.error) return access.error;
	const { id } = await params;
	try {
		return NextResponse.json({ accounts: await listGrantsForMailbox(access.env, access.user!.id, id) });
	} catch (error) {
		return accountErrorResponse(error);
	}
}

/** Set receive/send for many accounts on this mailbox, atomically and audited. */
export async function PUT(request: Request, { params }: MailboxAccessRouteParams) {
	const access = await requireTeamAdmin(request);
	if (access.error) return access.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const { id } = await params;
	const parsed = mailboxGrantsSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	try {
		return NextResponse.json(await applyGrantChanges(access.env, access.user!.id, parsed.data.grants.map((grant) => ({ mailboxId: id, ...grant }))));
	} catch (error) {
		return accountErrorResponse(error);
	}
}
