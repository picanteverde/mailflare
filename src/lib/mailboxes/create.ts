import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxAliases, mailboxes, users } from "@/db/schema";
import { AccountAdminError } from "@/lib/accounts/admin";
import { newId } from "@/lib/ids";
import { ensureMailboxDomainRouting } from "@/lib/mailboxes/domain-addresses";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { applyGrantChanges } from "@/lib/mailboxes/grants";

/*
 * picanteverde fork: creating a mailbox is admin-only (access design §2). The mailbox belongs
 * to the instance: its technical owner (mailboxes.user_id) is the domain's owner and grants
 * nothing. Whoever should read or send gets an explicit grant, optionally in the same request,
 * through the audited grants service. Shared/personal type and owner pickers are gone.
 */
export async function createMailboxForAdmin(
	env: CloudflareEnv,
	actorId: string,
	input: { domainId: string; localPart: string; displayName?: string | null; grants?: { userId: string; receive: boolean; send: boolean }[] },
) {
	const db = getDb(env);
	const [actor] = await db.select({ role: users.role, disabled: users.disabled }).from(users).where(eq(users.id, actorId)).limit(1);
	if (!actor || actor.disabled || actor.role !== "admin") throw new AccountAdminError("Forbidden", 403, "forbidden");
	for (const grant of input.grants ?? []) {
		if (grant.send && !grant.receive) throw new AccountAdminError("Send needs receive", 400, "send_without_receive");
	}
	// Check the grant accounts before creating anything, so a bad request leaves no mailbox behind.
	const grantUserIds = [...new Set((input.grants ?? []).map((grant) => grant.userId))];
	for (let index = 0; index < grantUserIds.length; index += 45) {
		const part = grantUserIds.slice(index, index + 45);
		const found = await db.select({ id: users.id }).from(users).where(inArray(users.id, part));
		if (found.length !== part.length) throw new AccountAdminError("Account not found", 404, "not_found");
	}
	const [domain] = await db.select().from(domains).where(eq(domains.id, input.domainId)).limit(1);
	if (!domain) throw new AccountAdminError("Domain not found", 404, "not_found");
	const localPart = input.localPart.trim().toLowerCase();
	const [existing] = await db.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.domainId, domain.id), eq(mailboxes.localPart, localPart))).limit(1);
	if (existing) throw new AccountAdminError("Mailbox already exists", 409, "mailbox_exists");
	const [alias] = await db.select({ id: mailboxAliases.id }).from(mailboxAliases).where(and(eq(mailboxAliases.domainId, domain.id), eq(mailboxAliases.localPart, localPart))).limit(1);
	if (alias) throw new AccountAdminError("An alias already uses this address", 409, "alias_exists");

	const id = newId("mbx");
	await db.insert(mailboxes).values({ id, userId: domain.userId, domainId: domain.id, localPart, displayName: input.displayName?.trim() || null, type: "shared" });
	try {
		await ensureMailboxDomainRouting(env, db, { id, domainId: domain.id, localPart, useAllDomains: true });
	} catch (error) {
		await db.delete(mailboxes).where(eq(mailboxes.id, id));
		throw new AccountAdminError(error instanceof Error ? error.message : "Failed to create Cloudflare routing rule", 502, "routing_failed");
	}
	await createAuditLog(env, { actorUserId: actorId, mailboxId: id, action: "mailbox.create", metadata: { address: `${localPart}@${domain.hostname}` } });
	if (input.grants?.length) {
		await applyGrantChanges(env, actorId, input.grants.map((grant) => ({ ...grant, mailboxId: id })));
	}
	return { id, address: `${localPart}@${domain.hostname}` };
}
