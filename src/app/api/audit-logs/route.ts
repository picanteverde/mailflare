import { desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { auditLogs, domains, mailboxes, users } from "@/db/schema";
import { assertPrimaryAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";

/** picanteverde fork: account, credential, grant and backup events (access design §7). */
const ACCESS_ACTIONS = [
	"account.create", "account.update", "account.role_change", "account.disable", "account.enable", "account.primary_transfer",
	"credentials.password_reset", "credentials.totp_reset", "session.revoke",
	"grant.set", "grant.revoke", "mailbox.create",
	"backup.download", "backup.restore",
	"webhook.create", "webhook.update", "webhook.delete",
];

export async function GET(request: Request) {
	const env = getEnv();
	const admin = await requireUser(env, request);
	try {
		assertPrimaryAdmin(admin);
	} catch {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}

	const url = new URL(request.url);
	const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 200);
	const db = getDb(env);
	const targetUsers = alias(users, "target_users");
	const rows = await db
		.select({
			id: auditLogs.id,
			action: auditLogs.action,
			metadata: auditLogs.metadata,
			createdAt: auditLogs.createdAt,
			actorEmail: users.email,
			targetEmail: targetUsers.email,
			mailboxLocalPart: mailboxes.localPart,
			mailboxHostname: domains.hostname,
		})
		.from(auditLogs)
		.leftJoin(users, eq(users.id, auditLogs.actorUserId))
		.leftJoin(targetUsers, eq(targetUsers.id, auditLogs.targetUserId))
		.leftJoin(mailboxes, eq(mailboxes.id, auditLogs.mailboxId))
		.leftJoin(domains, eq(domains.id, mailboxes.domainId))
		.where(inArray(auditLogs.action, url.searchParams.get("kind") === "access" ? ACCESS_ACTIONS : ["auth.login", "auth.logout"]))
		.orderBy(desc(auditLogs.createdAt))
		.limit(limit);

	return NextResponse.json({ auditLogs: rows });
}
