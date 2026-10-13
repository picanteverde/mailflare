import type { MailboxRevisionRow } from "./types";

/**
 * Covers every mailbox the user may receive from. picanteverde fork: the same rule
 * as can() in lib/mailboxes/access.ts (receive grant, enabled account and mailbox);
 * ownership and mailbox type grant nothing.
 */
export async function getUserMailRevision(env: CloudflareEnv, userId: string): Promise<string> {
	const result = await env.DB.prepare(`
		SELECT m.id AS mailbox_id, COALESCE(r.revision, 0) AS revision,
			CASE WHEN a.can_send = 1 THEN 'receive+send' ELSE 'receive' END AS permission
		FROM mailbox_access a
		JOIN users u ON u.id = a.user_id
		JOIN mailboxes m ON m.id = a.mailbox_id
		LEFT JOIN jmap_mailbox_revisions r ON r.mailbox_id = m.id
		WHERE a.user_id = ? AND a.can_receive = 1 AND u.disabled = 0 AND m.disabled = 0
		ORDER BY mailbox_id
	`).bind(userId).all<MailboxRevisionRow>();
	return JSON.stringify(result.results.map((row) => [row.mailbox_id, row.revision, row.permission]));
}
