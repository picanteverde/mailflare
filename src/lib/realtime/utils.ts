import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { mailboxAccess, mailboxes, users } from "@/db/schema";
import type { NewMessageNotification, AgentDraftNotification } from "./types";
import { sendPushNotifications } from "@/lib/push/server";

export function getSessionTokenFromRequest(request: Request): string | undefined {
	const cookie = request.headers.get("Cookie");
	if (!cookie) return undefined;

	for (const part of cookie.split(";")) {
		const [name, ...valueParts] = part.trim().split("=");
		if (name === "ep_session") {
			const value = valueParts.join("=");
			return value ? decodeURIComponent(value) : undefined;
		}
	}

	return undefined;
}

/**
 * picanteverde fork: only accounts that may receive from the mailbox are notified.
 * The mailbox owner and the domain owner no longer get every message by default.
 */
export async function getMailboxNotificationUserIds(env: CloudflareEnv, mailboxId: string): Promise<string[]> {
	const rows = await getDb(env)
		.select({ userId: mailboxAccess.userId })
		.from(mailboxAccess)
		.innerJoin(users, eq(users.id, mailboxAccess.userId))
		.innerJoin(mailboxes, eq(mailboxes.id, mailboxAccess.mailboxId))
		.where(and(eq(mailboxAccess.mailboxId, mailboxId), eq(mailboxAccess.canReceive, true), eq(users.disabled, false), eq(mailboxes.disabled, false)));
	return [...new Set(rows.map((row) => row.userId))];
}

export async function notifyUsersOfNewMessage(
	env: CloudflareEnv,
	userIds: string[],
	payload: NewMessageNotification | AgentDraftNotification,
): Promise<void> {
	// Next dev uses a bindings-only proxy; realtime delivery runs in worker.ts.
	if (!env.REALTIME) return;
	await Promise.allSettled([
		...userIds.map((userId) => {
			const hub = env.REALTIME.getByName(userId);
			return hub.fetch("https://mailflare-realtime/notify", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
		}),
		...(payload.type === "agent_draft" ? [] : [sendPushNotifications(env, userIds, payload)]),
	]);
}

/**
 * picanteverde fork: tell each account's open tabs that its mailbox grants changed, so they
 * drop the mailbox list cache and refetch (a revoked mailbox disappears within seconds). The
 * event carries no mailbox ids or mail data; the tab asks the server what it may see now.
 */
export async function notifyGrantsChanged(env: CloudflareEnv, userIds: string[]): Promise<void> {
	if (!env.REALTIME || userIds.length === 0) return;
	await Promise.allSettled([...new Set(userIds)].map((userId) =>
		env.REALTIME.getByName(userId).fetch("https://mailflare-realtime/notify", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "grants_changed" }),
		}),
	));
}
