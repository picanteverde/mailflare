-- picanteverde fork: mailbox access becomes two grants (receive, send) per account.
-- Hand-written; do not regenerate with drizzle-kit (the journal is incomplete).
-- The old `permission` column stays for compatibility but is never read for access
-- decisions; a later migration drops it.
-- Accounts are disabled, never deleted, so the ON DELETE CASCADE from users to
-- mailboxes/messages must never fire (see docs/picanteverde-access.md §3).
ALTER TABLE `mailbox_access` ADD `can_receive` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `mailbox_access` ADD `can_send` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `mailbox_access` ADD `granted_by_user_id` text REFERENCES `users`(`id`) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `mailbox_access` ADD `granted_at` integer;--> statement-breakpoint
-- Existing rows: every permission level could read; all but read_only could send.
UPDATE `mailbox_access`
SET `can_receive` = 1,
	`can_send` = CASE `permission` WHEN 'read_only' THEN 0 ELSE 1 END,
	`granted_by_user_id` = `created_by_user_id`,
	`granted_at` = `created_at`;--> statement-breakpoint
-- Owners keep full access to the mailboxes they own today: upgrade any existing row...
UPDATE `mailbox_access`
SET `can_receive` = 1, `can_send` = 1
WHERE EXISTS (
	SELECT 1 FROM `mailboxes` m
	WHERE m.`id` = `mailbox_access`.`mailbox_id` AND m.`user_id` = `mailbox_access`.`user_id`
);--> statement-breakpoint
-- ...and add a receive+send grant where none exists.
INSERT INTO `mailbox_access` (`id`, `mailbox_id`, `user_id`, `permission`, `created_by_user_id`, `created_at`, `can_receive`, `can_send`, `granted_by_user_id`, `granted_at`)
SELECT
	lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' ||
		substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
	m.`id`, m.`user_id`, 'full_access', NULL, unixepoch(), 1, 1, NULL, unixepoch()
FROM `mailboxes` m
WHERE NOT EXISTS (
	SELECT 1 FROM `mailbox_access` a WHERE a.`mailbox_id` = m.`id` AND a.`user_id` = m.`user_id`
);--> statement-breakpoint
CREATE INDEX `mailbox_access_user_receive_idx` ON `mailbox_access` (`user_id`, `can_receive`);--> statement-breakpoint
-- Sessions are revoked by deleting them; index the per-account sweep.
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
-- The audit log is append-only. Only the FK actions that null out a reference to a
-- removed user, mailbox or message may update a row; nothing may delete one.
CREATE TRIGGER `audit_logs_no_delete` BEFORE DELETE ON `audit_logs`
BEGIN
	SELECT RAISE(ABORT, 'audit_logs is append-only');
END;--> statement-breakpoint
CREATE TRIGGER `audit_logs_no_update` BEFORE UPDATE ON `audit_logs`
WHEN NEW.`id` IS NOT OLD.`id`
	OR NEW.`action` IS NOT OLD.`action`
	OR NEW.`metadata` IS NOT OLD.`metadata`
	OR NEW.`created_at` IS NOT OLD.`created_at`
	OR (NEW.`actor_user_id` IS NOT OLD.`actor_user_id` AND NEW.`actor_user_id` IS NOT NULL)
	OR (NEW.`target_user_id` IS NOT OLD.`target_user_id` AND NEW.`target_user_id` IS NOT NULL)
	OR (NEW.`mailbox_id` IS NOT OLD.`mailbox_id` AND NEW.`mailbox_id` IS NOT NULL)
	OR (NEW.`message_id` IS NOT OLD.`message_id` AND NEW.`message_id` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'audit_logs is append-only');
END;
