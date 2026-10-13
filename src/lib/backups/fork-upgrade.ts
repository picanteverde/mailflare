import type { DatabaseRecord } from "./types";

/*
 * picanteverde fork: restoring a backup taken before the access rework (Phase 8c). Such a
 * backup has mailbox_access rows with a legacy `permission` and no receive/send flags, and
 * contacts with no mailbox. These statements replay what migrations 0061 and 0063 did, inside
 * the restore batch, so an old backup comes back with the same access it had. Keep them in
 * step with those migrations (tests/access-backup-restore.test.mjs compares the results).
 */

/** Map one pre-0061 mailbox_access row to receive/send (read_only -> receive; others -> both). */
export function upgradeLegacyGrantRow(row: DatabaseRecord): DatabaseRecord {
	if ("can_receive" in row) return row;
	const { permission, ...rest } = row;
	return {
		...rest,
		can_receive: 1,
		can_send: permission === "read_only" ? 0 : 1,
		granted_by_user_id: row.created_by_user_id ?? null,
		granted_at: row.created_at ?? null,
	};
}

/** 0061: owners keep full access to the mailboxes they owned. */
export const OWNER_GRANT_BACKFILL_SQL = [
	"UPDATE `mailbox_access` SET `can_receive` = 1, `can_send` = 1 WHERE EXISTS (SELECT 1 FROM `mailboxes` m WHERE m.`id` = `mailbox_access`.`mailbox_id` AND m.`user_id` = `mailbox_access`.`user_id`)",
	"INSERT INTO `mailbox_access` (`id`, `mailbox_id`, `user_id`, `created_by_user_id`, `created_at`, `can_receive`, `can_send`, `granted_by_user_id`, `granted_at`) SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), m.`id`, m.`user_id`, NULL, unixepoch(), 1, 1, NULL, unixepoch() FROM `mailboxes` m WHERE NOT EXISTS (SELECT 1 FROM `mailbox_access` a WHERE a.`mailbox_id` = m.`id` AND a.`user_id` = m.`user_id`)",
];

/** 0063 (contacts per mailbox, from the mailbox's own mail and block rules) and 0066 (drop owner-wide rows). */
export const CONTACT_BACKFILL_SQL = [
	`INSERT INTO \`contacts\` (\`id\`, \`user_id\`, \`mailbox_id\`, \`email\`, \`display_name\`, \`avatar_key\`, \`source\`, \`blocked\`, \`last_seen_at\`, \`created_at\`)
SELECT m.\`id\` || ':' || c.\`email\`, c.\`user_id\`, m.\`id\`, c.\`email\`, c.\`display_name\`, c.\`avatar_key\`, c.\`source\`, 0,
	(SELECT max(x.\`created_at\`) FROM \`messages\` x
		WHERE x.\`mailbox_id\` = m.\`id\`
			AND (instr(',' || replace(replace(replace(replace(replace(replace(lower(coalesce(x.\`from_addr\`, '')), ' ', ','), char(9), ','), '<', ','), '>', ','), ';', ','), '"', ',') || ',', ',' || c.\`email\` || ',') > 0
				OR instr(',' || replace(replace(replace(replace(replace(replace(lower(coalesce(x.\`to_addr\`, '')), ' ', ','), char(9), ','), '<', ','), '>', ','), ';', ','), '"', ',') || ',', ',' || c.\`email\` || ',') > 0
				OR instr(',' || replace(replace(replace(replace(replace(replace(lower(coalesce(x.\`cc_addr\`, '')), ' ', ','), char(9), ','), '<', ','), '>', ','), ';', ','), '"', ',') || ',', ',' || c.\`email\` || ',') > 0)),
	c.\`created_at\`
FROM \`contacts\` c
JOIN \`mailboxes\` m ON m.\`user_id\` = c.\`user_id\`
WHERE c.\`mailbox_id\` IS NULL
	AND EXISTS (
		SELECT 1 FROM \`messages\` x
		WHERE x.\`mailbox_id\` = m.\`id\`
			AND (instr(',' || replace(replace(replace(replace(replace(replace(lower(coalesce(x.\`from_addr\`, '')), ' ', ','), char(9), ','), '<', ','), '>', ','), ';', ','), '"', ',') || ',', ',' || c.\`email\` || ',') > 0
				OR instr(',' || replace(replace(replace(replace(replace(replace(lower(coalesce(x.\`to_addr\`, '')), ' ', ','), char(9), ','), '<', ','), '>', ','), ';', ','), '"', ',') || ',', ',' || c.\`email\` || ',') > 0
				OR instr(',' || replace(replace(replace(replace(replace(replace(lower(coalesce(x.\`cc_addr\`, '')), ' ', ','), char(9), ','), '<', ','), '>', ','), ';', ','), '"', ',') || ',', ',' || c.\`email\` || ',') > 0)
	)`,
	`INSERT INTO \`contacts\` (\`id\`, \`user_id\`, \`mailbox_id\`, \`email\`, \`source\`, \`blocked\`, \`created_at\`)
SELECT r.\`mailbox_id\` || ':' || r.\`match_value\`, m.\`user_id\`, r.\`mailbox_id\`, r.\`match_value\`, 'inbound', 1, unixepoch()
FROM \`routing_rules\` r
JOIN \`mailboxes\` m ON m.\`id\` = r.\`mailbox_id\`
WHERE r.\`id\` LIKE 'block:%' AND r.\`action\` = 'trash' AND r.\`match_field\` = 'email' AND r.\`match_operator\` = 'exact'
	AND NOT EXISTS (SELECT 1 FROM \`contacts\` c WHERE c.\`mailbox_id\` = r.\`mailbox_id\` AND c.\`email\` = r.\`match_value\`)`,
	`UPDATE \`contacts\` SET \`blocked\` = 1
WHERE \`mailbox_id\` IS NOT NULL AND \`blocked\` = 0
	AND EXISTS (SELECT 1 FROM \`routing_rules\` r WHERE r.\`id\` = 'block:' || \`contacts\`.\`mailbox_id\` || ':' || \`contacts\`.\`email\` AND r.\`action\` = 'trash')`,
	"DELETE FROM `contacts` WHERE `mailbox_id` IS NULL",
];
