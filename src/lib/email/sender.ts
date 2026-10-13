import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxes, users } from "@/db/schema";
import { can } from "@/lib/mailboxes/access";
import { formatEmailAddress, getEmailAddress } from "@/lib/email/address";
import { getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import { resolveMailboxDisplayName } from "@/lib/profile/identity-utils";

export async function getAuthorizedSenderAddress(
	env: CloudflareEnv,
	input: {
		userId: string;
		from: string;
		mailboxId?: string | null;
	},
	/** Internal only (never from a request): the mailbox itself sends, e.g. its auto-reply. */
	options: { system?: boolean } = {},
): Promise<{ fromAddr: string; mailboxId: string }> {
	if (!input.mailboxId) throw new Error("Mailbox is required");

	const db = getDb(env);
	const [mailbox] = await db
		.select({
		localPart: mailboxes.localPart,
		displayName: mailboxes.displayName,
		type: mailboxes.type,
		ownerName: users.name,
		ownerEmail: users.email,
		hostname: domains.hostname,
		domainId: mailboxes.domainId,
		useAllDomains: mailboxes.useAllDomains,
			id: mailboxes.id,
		})
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.innerJoin(users, eq(mailboxes.userId, users.id))
		.where(eq(mailboxes.id, input.mailboxId))
		.limit(1);

	if (!mailbox) throw new Error("Mailbox not found");
	const [actor] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
	if (!actor || actor.disabled) throw new Error("Sender account not found");

	// picanteverde fork: the send grant is the only rule (access design §2). There is no
	// "X on behalf of Y" path: every send goes out as the mailbox, under its own name.
	if (!options.system && !(await can(db, actor, mailbox.id, "send"))) {
		throw new Error("You do not have permission to send from this mailbox");
	}

	// The From must be one of this mailbox's own addresses or aliases; an alias of another
	// mailbox, or any other address, is refused. The display name always comes from the mailbox.
	const requestedAddress = getEmailAddress(input.from);
	const permittedAddresses = await getMailboxDomainAddresses(db, mailbox);
	if (!permittedAddresses.includes(requestedAddress.toLowerCase())) {
		throw new Error("Sender address does not match the selected mailbox");
	}
	const senderAddress = requestedAddress.toLowerCase();
	// The primary mailbox sends under the account name; every other mailbox
	// sends under its own.
	const senderName = resolveMailboxDisplayName(mailbox, mailbox.ownerEmail, mailbox.ownerName);
	return {
		fromAddr: formatEmailAddress(senderAddress, senderName),
		mailboxId: mailbox.id,
	};
}
