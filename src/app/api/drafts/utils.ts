import type { AppDatabase } from "@/db";
import { getAuthorizedSenderAddress } from "@/lib/email/sender";
import { can } from "@/lib/mailboxes/access";
import type { DraftPayload } from "./types";

export async function getDraftSender(
	env: CloudflareEnv,
	userId: string,
	input: DraftPayload,
): Promise<{ fromAddr: string; mailboxId: string } | { error: string }> {
	try {
		return await getAuthorizedSenderAddress(env, {
			userId,
			from: input.from ?? "",
			mailboxId: input.mailboxId,
		});
	} catch (error) {
		return { error: error instanceof Error ? error.message : "Mailbox is not authorized" };
	}
}

/**
 * picanteverde fork: a draft is private to its author, and the author must still be
 * allowed to send from the draft's mailbox (access design §2). Losing the send grant
 * hides the draft like any other mail they can no longer use.
 */
export async function userOwnsDraft(
	db: AppDatabase,
	draft: { userId: string; status: string; mailboxId: string | null } | undefined,
	userId: string,
): Promise<boolean> {
	if (!draft || draft.userId !== userId || draft.status !== "draft" || !draft.mailboxId) return false;
	return can(db, { id: userId }, draft.mailboxId, "send");
}
