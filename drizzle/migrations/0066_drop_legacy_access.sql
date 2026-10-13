-- picanteverde fork: final schema for the access rework (Phase 8c).
-- The legacy permission level has not decided anything since 0061/Phase 3; can_receive and
-- can_send are the grant. Owner-wide contact rows (pre-0063, mailbox_id NULL) were never read
-- again. Contact avatar objects in R2 that only those rows pointed to are left as orphans.
-- Hand-written; do not regenerate with drizzle-kit.
ALTER TABLE `mailbox_access` DROP COLUMN `permission`;--> statement-breakpoint
DELETE FROM `contacts` WHERE `mailbox_id` IS NULL;
