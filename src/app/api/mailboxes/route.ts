import { NextResponse } from "next/server";
import { createMailboxForAdmin } from "@/lib/mailboxes/create";
import { accountErrorResponse } from "@/app/api/accounts/utils";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { and } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { mailboxes } from "@/db/schema";
import { listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { requireUser } from "@/lib/auth/cookies";
import { getLicenseEntitlements } from "@/lib/licenses/service";
import { tracksAccountIdentity } from "@/lib/profile/identity-utils";
import { mailboxSchema } from "@/lib/validators";
import { getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	const db = getDb(env);
	// picanteverde fork: no silent personal mailbox; an account sees only what it is granted.
	const rows = await listAccessibleMailboxes(db, user);
	const entitlements = await getLicenseEntitlements(env);
	return NextResponse.json({
		mailboxes: await Promise.all(rows.map(async (mailbox) => ({
			...mailbox,
			...(mailbox.userId === user.id && tracksAccountIdentity(mailbox, user.email)
				? { displayName: user.name, hasAvatar: !!user.avatarKey }
				: {}),
			senderAddresses: await getMailboxDomainAddresses(db, mailbox),
			canSend: !!mailbox.canSend,
		}))),
		canCreateShared: user.role === "admin" && entitlements.canShareMailboxes,
	});
}

/** picanteverde fork: admin-only; the mailbox belongs to the instance and access is granted explicitly. */
export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = mailboxSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}
	try {
		const created = await createMailboxForAdmin(env, user.id, parsed.data);
		return NextResponse.json({ ...created, type: "shared" });
	} catch (error) {
		return accountErrorResponse(error);
	}
}
