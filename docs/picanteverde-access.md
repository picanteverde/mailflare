# picanteverde fork: account and mailbox access design

Status: Phase 1 design note. Plan: [`picanteverde-access-plan.md`](picanteverde-access-plan.md).
Base: upstream `hieunc229/mailflare@2e24bfd` plus the fork commits on branch `picanteverde`.

## 1. Model

- An **account** is a login: email or username, password (bcrypt cost 12), and mandatory TOTP. Creating an account creates **no mailbox**.
- A **mailbox** is a shared resource owned by the instance. `mailboxes.user_id` stays a NOT NULL technical owner, set to the primary admin, and **never grants access by itself**.
- A **grant** is one `mailbox_access` row per (account, mailbox) with two booleans:
  - `can_receive`: read, search and organize the mailbox's mail.
  - `can_send`: send, reply and forward as the mailbox's addresses and aliases.
- **Default deny:** no row, or both flags 0, means no access. A disabled account or mailbox means no access, whatever the flags say.
- **Admins** (`users.role = 'admin'`) manage accounts, mailboxes and grants. They get **no implicit mail access**. To read a mailbox, an admin grants themselves, and that grant is audited like any other.
- **Single source of truth:** `can()` reads only `can_receive` and `can_send`. The legacy `permission` column stays for compatibility, is never read for decisions, and is dropped in a later migration.

## 2. Action map

`receive` = R, `send` = S, admin-only = A. "404" means a request about a mailbox the caller has no grant on answers 404 (§6).

| Area | Action | Needs |
|---|---|---|
| Mailboxes | list mailboxes and counts, select mailbox | R (only mailboxes with R are listed) |
| Messages | list, search (incl. FTS), thread view, open, original `.eml`, attachments, export | R on **each message's** mailbox. Threads that span mailboxes are filtered per message. |
| Organize | read/unread, star, snooze, move to folder, archive, spam/not spam, trash, bulk on these | R |
| Organize | move a message to **another mailbox** | R on **both** the source and the destination mailbox |
| Destroy | empty trash/spam, delete for good, trash-retention policy | A |
| Folders | use existing folders | R |
| Folders | create, rename, delete | A |
| Compose | send, reply, forward, scheduled send, cancel schedule | S on the mailbox the From resolves to |
| Drafts | create/edit own draft | S on the draft's From mailbox. Drafts are private to their author. |
| Templates | own templates | the author only; using one to send still needs S |
| Contacts | view contacts and blocks derived from a mailbox | R |
| Contacts | edit mailbox-wide blocks | A |
| Mailbox settings | name, signature, auto-reply, aliases, avatar, routing rules, forwarding, webhooks, spam settings | A |
| Import | IMAP / message import into a mailbox | A |
| Backups | download, restore, scheduled backup | A, audited |
| API keys (`/api/v1/*`, MCP, JMAP) | per-key mailbox scope | key scope ∩ the owner's grants, re-checked **every request**. Reads need R, submission needs S. A key stops working at once when its account is disabled or its sessions are revoked. |
| Realtime / push | new-mail events, revision polling, push notifications | R |
| Agent (AI off in this deployment) | chat, auto-draft, reviewer | R to read, S to send. The reviewer must hold R+S. |
| Accounts | create, disable/enable, role, reset password/TOTP, revoke sessions | A, audited |
| Grants | grant/revoke R or S | A, audited |

The route-by-route inventory (Phase 4) lists every handler with the row above that applies, and gets ticked off as each one is converted.

## 3. Ownership and deletion

- Mailboxes are never deleted by deleting an account. The account API offers **disable**, not delete, so the `ON DELETE CASCADE` on `mailboxes.user_id` and `messages.user_id` is never triggered.
- `messages.user_id` stays as recorded data (inbound: technical owner; outbound/drafts: author) and **never** decides access.
- Settings that hang off the owner today (contacts, spam settings, forwarding, webhooks, auto-reply sender, trash retention, agent reviewer) move to mailbox scope, edited by admins.
- `ensurePersonalMailbox`, which silently recreates a personal mailbox on `GET /api/mailboxes`, is removed.

## 4. Sessions and credentials

- Every request re-reads the session and the grants. There is no server-side cache, so a grant change applies on the account's next request.
- Password reset, account disable, TOTP reset and an explicit "revoke sessions" delete or revoke all of the account's sessions and close its realtime WebSockets.
- TOTP is mandatory for every account. Until enrollment is complete, only the enrollment and logout endpoints answer; everything else returns 403 `totp_enrollment_required`.
- API keys follow their account: every request with a key re-checks that the owning account is enabled and that the key was created after the account's last session revocation. Disable or "revoke sessions" therefore kills the keys too.
- **Last-admin protection:** the last enabled admin can't be disabled or demoted, and an admin can't demote or disable themselves when no other enabled admin remains. The API answers 409 `last_admin`.
- Login: the existing IP rate limit (`LOGIN_RATE_LIMIT`, 20/min) and Turnstile apply to every account. A **per-account backoff** is added with increasing delays after consecutive failures, never a hard lock, so an outsider can't lock a real user out on purpose.

## 5. Upstream features disabled or changed in this fork

| Upstream behaviour | In this fork |
|---|---|
| `canManageAccounts` / seat limits (Pro) | removed: any admin can create accounts |
| `canShareMailboxes` / `type='shared'` (Team) | removed: every mailbox is shareable through grants, and `type` is ignored for access |
| `isTeamMailboxSharingEnabled` license reads | removed |
| booking hosts gated by `canShareMailboxes` | gated by "account has R on the host mailbox" |
| `canForwardEmail` (license) | forwarding is a mailbox setting, admin-only |
| `canCustomizeBranding` (license) | unchanged (still license-gated; out of scope) |
| License page and upgrade prompts tied to accounts/sharing | hidden |
| Notifications to the domain owner for every message | removed: only accounts with R are notified |
| `send_on_behalf` "X on behalf of Y" | removed: S sends as the mailbox |

## 6. Response rule (no existence leaks)

- A mailbox, message, thread, attachment or `.eml` the caller has no R grant for answers **404**, the same as a missing one.
- A mailbox the caller can read but not send from answers **403** on send. The caller already knows that mailbox exists.
- Admin-only actions by non-admins answer 403.
- Signed or presigned R2 URLs, if ever introduced, expire in ≤ 5 minutes. Revoking access can't invalidate a URL already issued.

## 7. Audit events

The audit log is **admin-read-only and append-only**. No API updates or deletes `audit_logs` rows (backup restore included). Migration 0061 adds SQLite triggers that reject any `DELETE` and any `UPDATE`, except the foreign-key actions that null out a reference to a removed user, mailbox or message.

All are written to `audit_logs` with `actor_user_id`, `target_user_id`, `mailbox_id` (if any), `action`, JSON `metadata` and a timestamp. Mail bodies and subjects are never logged.

| action | metadata |
|---|---|
| `account.create` | login, role |
| `account.disable` / `account.enable` | reason (optional) |
| `account.role_change` | from, to |
| `credentials.password_reset` | by_admin: bool, target_is_admin: bool |
| `credentials.totp_reset` | target_is_admin: bool |
| `session.revoke` | count |
| `grant.set` | mailbox_id, receive: bool, send: bool, previous: {receive, send} |
| `grant.revoke` | mailbox_id, previous |
| `mailbox.create` / `mailbox.disable` / `mailbox.settings_change` | changed fields (names only) |
| `backup.download` / `backup.restore` | backup id |
| `mail.send` | mailbox_id, message_id (no content) |
| `mail.move_mailbox` | from_mailbox_id, to_mailbox_id, message_id |

An admin resetting **another admin's** password or TOTP (`target_is_admin: true`) is the main event to watch. The admin audit view highlights it.

## 8. Release gate

Phases 1–9 go only to the fork and to a **staging worker** with synthetic seed data. Production `mailflare` is touched only in Phase 10, after the Phase 9 test matrix passes and QA signs off. Phase 6 removes the license gates, so shipping it before Phase 4 closes the bypasses would hand new accounts the leaky routes.

No copies of production mail go to staging. If a production D1 copy is ever needed for the migration count comparison, it is used only for that, deleted right after, and the deletion is posted in Teams.

## 9. Upstream sync

- The bot checks `hieunc229/mailflare` releases and security advisories weekly.
- **Security fixes** are cherry-picked onto `picanteverde` within 48 h, tested, QA-reviewed and deployed.
- **Regular syncs:** rebase `picanteverde` onto the new upstream tip on a temporary branch, run `node --test tests/*.test.mjs` and the build, have QA review the diff, then fast-forward.
- Fork changes stay concentrated in: `src/lib/mailboxes/access*.ts`, `src/lib/email/sender.ts`, `src/app/api/accounts/**`, `src/app/api/mailboxes/**`, `src/lib/realtime/*`, the admin pages for accounts and mailboxes, the `0061+` migrations and `tests/access-*`. Expect conflicts there.
- AGPL: the fork stays public, `NOTICE` lists our changes, and the app footer links the source.
