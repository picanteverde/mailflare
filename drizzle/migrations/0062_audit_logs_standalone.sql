-- picanteverde fork: the audit log is a historical record, so it holds no foreign keys.
-- With the 0007 FKs, deleting (or restoring over) a user, mailbox or message rewrote
-- old audit rows (ON DELETE SET NULL), and the append-only trigger from 0061 had to
-- allow that. Rebuilt without FKs, the triggers can reject every UPDATE and DELETE.
-- Hand-written; do not regenerate with drizzle-kit.
DROP TRIGGER IF EXISTS `audit_logs_no_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `audit_logs_no_delete`;--> statement-breakpoint
CREATE TABLE `audit_logs_new` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`target_user_id` text,
	`mailbox_id` text,
	`message_id` text,
	`action` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `audit_logs_new` (`id`, `actor_user_id`, `target_user_id`, `mailbox_id`, `message_id`, `action`, `metadata`, `created_at`)
SELECT `id`, `actor_user_id`, `target_user_id`, `mailbox_id`, `message_id`, `action`, `metadata`, `created_at` FROM `audit_logs`;--> statement-breakpoint
DROP TABLE `audit_logs`;--> statement-breakpoint
ALTER TABLE `audit_logs_new` RENAME TO `audit_logs`;--> statement-breakpoint
CREATE INDEX `audit_logs_actor_idx` ON `audit_logs` (`actor_user_id`);--> statement-breakpoint
CREATE INDEX `audit_logs_mailbox_idx` ON `audit_logs` (`mailbox_id`);--> statement-breakpoint
CREATE INDEX `audit_logs_created_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE TRIGGER `audit_logs_no_delete` BEFORE DELETE ON `audit_logs`
BEGIN
	SELECT RAISE(ABORT, 'audit_logs is append-only');
END;--> statement-breakpoint
CREATE TRIGGER `audit_logs_no_update` BEFORE UPDATE ON `audit_logs`
BEGIN
	SELECT RAISE(ABORT, 'audit_logs is append-only');
END;
