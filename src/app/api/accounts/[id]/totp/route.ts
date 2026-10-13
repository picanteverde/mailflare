import { NextResponse } from "next/server";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { resetAccountTotp } from "@/lib/accounts/admin";
import { accountErrorResponse, requireTeamAdmin } from "../../utils";
import type { AccountRouteParams } from "../types";

/** picanteverde fork: clears the account's authenticator; it must enroll again to sign in. */
export async function DELETE(request: Request, { params }: AccountRouteParams) {
	const access = await requireTeamAdmin(request);
	if (access.error) return access.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const { id } = await params;
	try {
		return NextResponse.json(await resetAccountTotp(access.env, access.user!.id, id));
	} catch (error) {
		return accountErrorResponse(error);
	}
}
