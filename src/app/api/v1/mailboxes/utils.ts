import { NextResponse } from "next/server";
import { createMailboxForAdmin } from "@/lib/mailboxes/create";
import { accountErrorResponse } from "@/app/api/accounts/utils";
import { and, eq, or } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { domains, mailboxes, users } from "@/db/schema";
import { authenticateAdminApiKey } from "@/lib/api/admin-auth";
import { mailboxSchema } from "@/lib/validators";

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "mailboxes");
	if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const rows = await getDb(env).select({
		id: mailboxes.id, userId: mailboxes.userId, domainId: mailboxes.domainId,
		localPart: mailboxes.localPart, hostname: domains.hostname,
		displayName: mailboxes.displayName, type: mailboxes.type,
		disabled: mailboxes.disabled, createdAt: mailboxes.createdAt,
	}).from(mailboxes).innerJoin(users, eq(mailboxes.userId, users.id)).innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.where(or(eq(users.id, auth.userId), eq(users.createdByUserId, auth.userId)));
	return NextResponse.json({ mailboxes: rows });
}

/** picanteverde fork: admin-only; the mailbox belongs to the instance and access is granted explicitly. */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "mailboxes");
	if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const parsed = mailboxSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	try {
		const created = await createMailboxForAdmin(env, auth.userId, parsed.data);
		return NextResponse.json({ ...created, type: "shared" }, { status: 201 });
	} catch (error) {
		return accountErrorResponse(error);
	}
}
