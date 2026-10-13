-- picanteverde fork: "revoke sessions" (and password reset, disable, TOTP reset) records
-- when it happened. Sessions, API keys and realtime sockets created at or before this
-- time stop working (access design §4). Hand-written; do not regenerate with drizzle-kit.
ALTER TABLE `users` ADD `sessions_revoked_at` integer;
