import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { updateManagedAccountSchema } from "@/lib/validators";
import { getLicenseEntitlements } from "@/lib/licenses/service";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { updateManagedAccount } from "@/lib/accounts/admin";
import { accountErrorResponse, requireTeamAdmin } from "../utils";
import type { AccountRouteParams } from "./types";
import { selectAccountById } from "./utils";

export async function GET(request: Request, { params }: AccountRouteParams) {
	const access = await requireTeamAdmin(request);
	if (access.error) return access.error;
	const { id } = await params;
	const account = await selectAccountById(getDb(access.env), id);
	if (!account) {
		return NextResponse.json({ error: "Account not found" }, { status: 404 });
	}
	const actor = access.user!;
	const actorIsPrimary = isPrimaryAdmin(actor);
	return NextResponse.json({
		account: {
			id: account.id,
			email: account.email,
			name: account.name,
			role: account.role,
			isPrimaryAdmin: account.isPrimaryAdmin,
			disabled: account.disabled,
			totpEnabled: account.totpEnabled,
			forwardingEmail: account.forwardingEmail,
			canForwardEmail: (await getLicenseEntitlements(access.env)).canForwardEmail,
			hasAvatar: !!account.avatarKey,
			// picanteverde fork: admin is all-or-nothing; admin accounts and roles are the primary admin's.
			editable: actorIsPrimary || (account.role === "user" && !account.isPrimaryAdmin) || account.id === actor.id,
			canChangeRole: actorIsPrimary && !account.isPrimaryAdmin,
			canTransferPrimary: actorIsPrimary && !account.isPrimaryAdmin && !account.disabled,
		},
	});
}

export async function PATCH(request: Request, { params }: AccountRouteParams) {
	const access = await requireTeamAdmin(request);
	if (access.error) return access.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const { id } = await params;
	const parsed = updateManagedAccountSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	const canForwardEmail = (await getLicenseEntitlements(access.env)).canForwardEmail;
	if (!canForwardEmail && parsed.data.forwardingEmail) {
		return NextResponse.json({ error: "A Pro or Team license is required for email forwarding" }, { status: 403 });
	}
	try {
		await updateManagedAccount(access.env, access.user!.id, id, {
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
