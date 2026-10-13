-- picanteverde fork: per-login, per-client backoff after failed sign-ins (access design §4).
-- Keyed by sha256(step | login | client IP), so failures from one network never slow down the
-- real user on another: increasing delays, never a lock. Hand-written; do not regenerate.
CREATE TABLE `login_backoff` (
	`key` text PRIMARY KEY NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`next_allowed_at` integer,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `login_backoff_updated_idx` ON `login_backoff` (`updated_at`);
