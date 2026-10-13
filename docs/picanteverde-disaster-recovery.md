# picanteverde fork: disaster recovery runbook

In-app restore is **turned off** (`POST /api/backups/restore` answers 410). On Cloudflare D1 a single atomic restore over a database that already holds mail exceeds the D1 CPU limit at a few thousand messages. On staging, 5k messages failed every time, safely and with nothing changed. The in-app **backup** (export) stays useful as an offline copy and for inspection.

Recovery has two independent parts:

| What | Where it lives | How it comes back |
|---|---|---|
| Accounts, grants, settings, message metadata and bodies, audit log | D1 `mailflare` | **D1 Time Travel**: any point in the last 30 days (paid plan) |
| Raw `.eml`, attachments, Drive files, in-app backup files | R2 `mailflare-raw` | **Weekly R2 copy** to a separate bucket (the copy job; required before Phase 10) |

D1 rows point into R2 by key (`messages.raw_r2_key`, `message_attachments.r2_key`, `drive_items.r2_key`). After a D1 restore to time T, every key it references existed at T. Objects written after T are orphans, which is harmless. An object deleted after T is gone from `mailflare-raw` and must come from the latest R2 copy taken **at or after** T, or the message shows without its original or attachment.

## 1. Decide the restore point

- Pick a time just before the damage, in UTC (RFC3339, e.g. `2026-10-13T12:43:30Z`), or a Unix timestamp.
- Optional: `wrangler d1 time-travel info mailflare --timestamp=<T>` shows the bookmark Cloudflare will use.
- Post the planned T and the reason in Teams. **Restoring production needs QA's explicit sign-off** (irreversible-ops rule).

## 2. Restore D1

```bash
# Production (from a checkout of the deployed branch, with the deploy token in CLOUDFLARE_API_TOKEN)
npx wrangler d1 time-travel restore mailflare --timestamp=<T> --json
# Staging
npx wrangler d1 time-travel restore mailflare-staging --env staging --timestamp=<T> --json
```

- The output has `bookmark` (the state now restored) and **`previous_bookmark`** (the state just before the restore). **Save `previous_bookmark`.** It undoes the restore: `wrangler d1 time-travel restore <db> --bookmark=<previous_bookmark>`.
- The restore resets the database's Durable Object, so expect a few seconds of errors and in-flight requests failing.

## 3. Bring back R2 objects if needed

- List the message and attachment keys the restored D1 references, check which are missing from `mailflare-raw`, and copy those from the backup bucket copy taken at or after T. Use `wrangler r2 object get/put`, or the copy job's restore mode once it exists.
- Do not bulk-overwrite `mailflare-raw` from an older copy. That would replace newer objects that the restored D1 does not reference but that are harmless to keep.

## 4. After the restore

- Sessions and grants are as they were at T: **revocations and password resets made after T are undone.** Re-apply them (Accounts → Sign out everywhere / Reset two-factor, Mailbox → Access) and check the Access history.
- The audit log is also as it was at T. Record the restore and the rows that were lost in Teams.
- Check with the access matrix (`scratchpad/staging/matrix.py` pattern) on staging before a production restore, if time allows.

## Rehearsed

- **2026-10-13, staging:** recorded T0 (5,012 messages, 6 grants, 7 users). Deleted 100 messages, revoked a grant and added a marker account. Ran `time-travel restore mailflare-staging --timestamp=T0`. Counts matched T0 exactly (the marker was gone and the grant was back).
