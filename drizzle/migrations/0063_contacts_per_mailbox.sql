-- picanteverde fork: contacts belong to a mailbox, not to the mailbox owner.
-- Every mailbox is owned by the primary admin, so per-owner contacts were one
-- global address book: reading any mailbox revealed names, blocks and lastSeenAt
-- learned from all the others (QA, Phase 4 review).
-- Hand-written; do not regenerate with drizzle-kit.
ALTER TABLE `contacts` ADD `mailbox_id` text REFERENCES `mailboxes`(`id`) ON DELETE cascade;--> statement-breakpoint
DROP INDEX IF EXISTS `contacts_user_email_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_mailbox_email_idx` ON `contacts` (`mailbox_id`, `email`);--> statement-breakpoint
CREATE INDEX `contacts_mailbox_idx` ON `contacts` (`mailbox_id`);--> statement-breakpoint
-- Backfill: one row per (owner contact, owner's mailbox that actually exchanged mail with
-- that address), with lastSeenAt from that mailbox's own messages. Ids use the new
-- `<mailboxId>:<email>` format, matching getContactId(). Addresses match whole entries only
-- (brackets, spaces, quotes and separators become commas), so bob@x.com never matches
-- jimbob@x.com or bob@x.com.evil. `blocked` starts at 0: blocks were per mailbox (routing
-- rules) and are set by the two statements below, never copied from the owner-wide row.
INSERT INTO `contacts` (`id`, `user_id`, `mailbox_id`, `email`, `display_name`, `avatar_key`, `source`, `blocked`, `last_seen_at`, `created_at`)
SELECT m.`id` || ':' || c.`email`, c.`user_id`, m.`id`, c.`email`, c.`display_name`, c.`avatar_key`, c.`source`, 0,
	(SELECT max(x.`created_at`) FROM `messages` x
		WHERE x.`mailbox_id` = m.`id`
			AND (instr(',' || replace(replace(replace(replace(replace(replace(lower(coalesce(x.`from_addr`, '')), ' ', ','), char(9), ','), '<', ','), '>', ','), ';', ','), '"', ',') || ',', ',' || c.`email` || ',') > 0
				OR instr(',' || replace(replace(replace(replace(replace(replace(lower(coalesce(x.`to_addr`, '')), ' ', ','), char(9), ','), '<', ','), '>', ','), ';', ','), '"', ',') || ',', ',' || c.`email` || ',') > 0
				OR instr(',' || replace(replace(replace(replace(replace(replace(lower(coalesce(x.`cc_addr`, '')), ' ', ','), char(9), ','), '<', ','), '>', ','), ';', ','), '"', ',') || ',', ',' || c.`email` || ',') > 0)),
	c.`created_at`
FROM `contacts` c
JOIN `mailboxes` m ON m.`user_id` = c.`user_id`
WHERE c.`mailbox_id` IS NULL
	AND EXISTS (
		SELECT 1 FROM `messages` x
		WHERE x.`mailbox_id` = m.`id`
			AND (instr(',' || replace(replace(replace(replace(replace(replace(lower(coalesce(x.`from_addr`, '')), ' ', ','), char(9), ','), '<', ','), '>', ','), ';', ','), '"', ',') || ',', ',' || c.`email` || ',') > 0
				OR instr(',' || replace(replace(replace(replace(replace(replace(lower(coalesce(x.`to_addr`, '')), ' ', ','), char(9), ','), '<', ','), '>', ','), ';', ','), '"', ',') || ',', ',' || c.`email` || ',') > 0
				OR instr(',' || replace(replace(replace(replace(replace(replace(lower(coalesce(x.`cc_addr`, '')), ' ', ','), char(9), ','), '<', ','), '>', ','), ';', ','), '"', ',') || ',', ',' || c.`email` || ',') > 0)
	);--> statement-breakpoint
-- Blocks were applied per mailbox as routing rules (`block:<mailboxId>:<email>`); keep the
-- contact flag in the mailbox that set the block even if it never got mail from the address.
INSERT INTO `contacts` (`id`, `user_id`, `mailbox_id`, `email`, `source`, `blocked`, `created_at`)
SELECT r.`mailbox_id` || ':' || r.`match_value`, m.`user_id`, r.`mailbox_id`, r.`match_value`, 'inbound', 1, unixepoch()
FROM `routing_rules` r
JOIN `mailboxes` m ON m.`id` = r.`mailbox_id`
WHERE r.`id` LIKE 'block:%' AND r.`action` = 'trash' AND r.`match_field` = 'email' AND r.`match_operator` = 'exact'
	AND NOT EXISTS (SELECT 1 FROM `contacts` c WHERE c.`mailbox_id` = r.`mailbox_id` AND c.`email` = r.`match_value`);--> statement-breakpoint
UPDATE `contacts` SET `blocked` = 1
WHERE `mailbox_id` IS NOT NULL AND `blocked` = 0
	AND EXISTS (SELECT 1 FROM `routing_rules` r WHERE r.`id` = 'block:' || `contacts`.`mailbox_id` || ':' || `contacts`.`email` AND r.`action` = 'trash');
-- Legacy owner-wide rows (mailbox_id IS NULL) are left in place but never read: every
-- lookup filters by mailbox_id. A later migration removes them.
