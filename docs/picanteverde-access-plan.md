# Accounts are logins, mailboxes are shared

_picanteverde fork of mailflare: plan for accounts as logins and per-mailbox receive/send grants._

An admin creates accounts as plain credentials, creates mailboxes, and grants each account **receive** and/or **send** on each mailbox. One mailbox can serve many accounts and one account can work in many mailboxes. Nothing is visible until it is granted, and every check happens on the server.

## Decisions for picanteverde

- **PERMS**: Two grants per account and mailbox: **receive** covers reading, searching and organizing (read/unread, star, move, archive, trash, snooze), and **send** covers send, reply and forward as the mailbox. Mailbox settings, aliases, routing rules, auto-reply, deleting mail for good and import stay admin-only. Do you need a read-only level that can't move or trash mail? [Phase 1]
- **STATE**: Read, star and folder state stay **shared per mailbox**, as upstream works today, so if one person reads a message it's read for everyone, like a team inbox. Per-person read state would add a phase of work. [Phases 1–2]
- **ADMIN**: Admins get **no automatic** access to mail. They manage accounts and grants, but read a mailbox only if they grant themselves receive, and that grant goes in the audit log. [Phase 3]
- **TOTP**: TOTP is required for **every** account, and the first login forces enrollment. That's stricter than QA's minimum (admins only). [Phase 6]
- **DRAFTS**: Drafts and templates stay private to the person who wrote them. Mailbox co-members can't see each other's drafts. [Phase 5]

## QA requirements → where they're handled

| Requirement | Phases |
|---|---|
| 1 Central check, every path | Phases 3–4 (+ the route-by-route list in Phase 4) |
| 2 Default deny, immediate effect | Phases 2, 3, 8 |
| 3 Send covers the From address | Phase 5 |
| 4 Credentials (hashing, TOTP, sessions, rate limit, Turnstile) | Phase 6 |
| 5 Admin actions logged | Phases 6–7 |
| 6 Per-route A→B tests + migration keeps mail | Phases 2, 9 |
| 7 Upstream drift | Phase 10 |

## Phase 1: Design decisions and guardrails

_Pin down the model before touching code_. Depends on: None. Delivers: docs/picanteverde-access.md (design note in the fork).

1. Write down the grant model: receive and send per account and mailbox, with admin-only actions listed explicitly.
2. Map every existing action to receive, send or admin-only, using the route list from Phase 4 as the checklist.
3. Decide that mailboxes are owned by the instance; keep mailboxes.user_id pointing at the primary admin as a technical owner only.
4. Decide what happens on account delete: disable only, never cascade-delete mailboxes or mail.
5. Decide the session policy: password reset, disable or revoke ends all of that account's sessions immediately.
6. List upstream features turned off in the fork (license gates, seat limits, the Team-only booking host check) and how each behaves instead.
7. Define the audit events (account.*, grant.*, credentials.*, session.revoke) and the metadata each one records.
8. Define the 403-vs-404 rule: a mailbox the account can't access answers 404, so its existence isn't leaked.
9. Record the upstream sync policy (Phase 10) in the note.
10. Post the note for QA review and adjust it.

**Done when:** picanteverde has answered the five decisions above, and QA has signed off the design note.

## Phase 2: Data model and migration

_Hand-written 0061 migration that keeps all existing mail_. Depends on: Phase 1. Delivers: drizzle/migrations/0061_mailbox_grants.sql + schema update.

1. Add can_receive and can_send (boolean, default 0) plus granted_by_user_id and granted_at to mailbox_access, keeping the old permission column for compatibility.
2. Backfill existing mailbox_access rows: full_access and send_as become receive+send, send_on_behalf becomes receive+send, read_only becomes receive only.
3. Backfill the current admin with receive+send on every mailbox they own today, so nothing disappears for them.
4. Stop the cascade: user deletes become soft-disable in the API, and the migration notes that the FK cascade must never be triggered.
5. Add a sessions.revoked_at column (or reuse deletion) and an index on (user_id) for fast revocation.
6. Add an index on mailbox_access (user_id, can_receive) and (mailbox_id) for the hot check.
7. Write the migration by hand. drizzle-kit generate is broken in this repo (incomplete journal), so don't use it.
8. Update src/db/schema/index.ts to match the SQL exactly.
9. Migration test: run 0000→0061 on in-memory SQLite, seed today's shape, check the counts afterwards.
10. Dry run on a D1 export of production (copy into a scratch DB), compare message and mailbox counts before and after.

**Done when:** The migration applies cleanly with all three runners (wrangler, the in-app bundle, server/runtime), and a copy of today's production D1 keeps every message and mailbox.

## Phase 3: Central authorization check

_One can(account, mailbox, action), default deny_. Depends on: Phase 2. Delivers: src/lib/mailboxes/access.ts rewritten.

1. Rewrite getMailboxAccessLevel as can(db, account, mailboxId, 'receive'|'send'|'admin'), reading the grant row on every call with no cache.
2. Return canRead, canOrganize and canSend from the grant; canManage becomes 'admin role' for mailbox settings.
3. Remove the type='shared' filter and the isTeamMailboxSharingEnabled / license checks from access.ts and access-utils.ts.
4. Rewrite listAccessibleMailboxes and listAccessibleMailboxIds from grants only; owning a mailbox no longer grants anything by itself.
5. Treat disabled accounts and disabled mailboxes as no access at all, everywhere.
6. Rewrite lib/realtime/revision.ts so its raw SQL uses the same grant rule.
7. Rewrite getMailboxNotificationUserIds: receive grants only. Drop the 'domain owner gets everything' leak.
8. Point lib/jmap/access.ts, lib/mcp/server.ts and lib/drive/attachments.ts at the new helpers.
9. Add a small batch helper (accessibleMailboxIds once per request) for bulk and agent loops.
10. Write unit tests for can(): grant combinations, a disabled account, a disabled mailbox, no grant, and an admin without a grant.

**Done when:** can() is the only access rule in the codebase. The raw SQL in realtime/revision.ts and the notification recipients read from the same grant table. Unit tests cover every action.

## Phase 4: Close every route that bypasses the check

_Route-by-route, the ~30 direct ownership filters_. Depends on: Phase 3. Delivers: Every mail path goes through can().

1. Messages list, counts and navigation: drop the messages.user_id fallback and filter by accessibleMailboxIds (receive).
2. Message read, thread view, original .eml (R2) and attachments (R2): check receive on the message's mailbox before reading R2.
3. Organize actions (read, star, snooze, move, bulk, empty, trash, spam feedback): check receive; deleting for good stays admin-only.
4. Export and import: export needs receive on every mailbox included; import is admin-only.
5. lib/user.ts legacy helpers (listMessagesForUser, markMessageAsRead, updateMessageStatus): reroute them through can() or delete them.
6. Contacts and blocks: give contacts a mailbox-level home and require receive to view, admin to edit mailbox-wide blocks.
7. API keys and /api/v1/*: re-check key mailboxIds against the account's grants in key-auth.ts on every request.
8. JMAP and MCP: enforce receive for reads and send for submission. 'Not read_only' no longer means writable.
9. Crons and queues (trash retention, agent jobs, outbound queue, backups): act per mailbox and re-check send at dequeue time for outbound mail.
10. Write the inventory doc listing every route and the action it needs, ticked off as each is converted.

**Done when:** The inventory list has a ✔ on every route; grep shows no messages.user_id or mailboxes.user_id used as an access rule outside the helper.

## Phase 5: Sending and the From address

_Send permission is enforced on the server_. Depends on: Phase 3. Delivers: sender.ts, compose, drafts, JMAP identities.

1. getAuthorizedSenderAddress: resolve the requested From to a mailbox or alias and require send on that mailbox; drop the on-behalf fallback.
2. Apply it in sendEmail, /api/send, /api/v1/send, drafts send, scheduled sends and JMAP EmailSubmission.
3. Re-check send when the outbound queue job runs, so a grant revoked after scheduling is still respected.
4. Reply and forward: the From defaults to the mailbox the thread is in, and only if the account has send there.
5. Compose 'From' dropdown: only list mailboxes and aliases with send (filter senderOptions).
6. JMAP identities: only expose identities for mailboxes with send.
7. Drafts stay private to the author; check send again when the draft is sent, not just when it was created.
8. Reject Reply-To or Sender headers that try to impersonate another local mailbox.
9. Write the audit log entry for each send (account, mailbox, message id), with no body content.
10. Tests: send with no grant, receive only, revoked mid-schedule, forged From, and an alias of another mailbox.

**Done when:** Sending as a mailbox without the send grant is refused (403) on every send path, even with a hand-crafted From. Compose only offers addresses the account may send as.

## Phase 6: Accounts and credentials

_Accounts are logins, decoupled from mailboxes_. Depends on: Phase 2. Delivers: Account APIs without license gates.

1. Change createAccountResponse to create credentials only (login email + password); no personal mailbox or aliases.
2. Allow a login email on any domain, or a plain username, so a login doesn't have to equal a mailbox address.
3. Remove ensurePersonalMailbox, which today silently recreates a mailbox on every GET /api/mailboxes.
4. Remove the license and seat gates (requireTeamAdmin, canManageAccounts, getAccountSeatError) from /api/accounts/** and v1 accounts.
5. Keep bcrypt cost 12; enforce a minimum password length and a breach-list check if it's cheap.
6. Mandatory TOTP: block mail APIs until enrollment is done; admin-triggered TOTP reset is audited.
7. Per-account session revocation endpoint; password reset, disable and TOTP reset also revoke all sessions.
8. Confirm the login rate limit and Turnstile apply to every account (they're per-route today), and add a per-account lockout after repeated failures.
9. Audit every admin action on accounts: create, disable/enable, role change, password reset, TOTP reset, revoke sessions.
10. Make auth/me and auth-guard use grants, so a new account with no grants sees an 'ask your admin' page instead of an empty mailbox.

**Done when:** An admin can create, disable and reset accounts without a license. A new account has no mailbox and must enroll TOTP on first login. Revocation ends sessions immediately.

## Phase 7: Admin interface

_Grant receive/send from both sides_. Depends on: Phases 3, 6. Delivers: Updated admin pages.

1. Accounts list: remove the LicenseRequiredOverlay and seat counter; add create account (email or username, temporary password).
2. Account detail → 'Mailboxes' tab: a table of all mailboxes with receive and send toggles per row.
3. Mailbox detail → 'Access' card: a table of accounts with receive and send toggles, available for every mailbox, not just shared ones.
4. Bulk actions: grant one account to many mailboxes, or many accounts to one mailbox.
5. Create mailbox page: no owner picker or 'shared' type; optionally grant accounts on create.
6. Account actions: disable/enable, reset password, reset TOTP, revoke sessions, all behind a confirm step.
7. Audit log page filtered to account and grant events, showing who, what, when and the target.
8. Admin nav: hide the License page; remove the Team/Pro badges and upgrade prompts tied to these features.
9. Implement the 410 stub api/accounts/[id]/mailbox-access as the grants API used by these screens.
10. Accessibility and mobile pass on the new screens.

**Done when:** From an account's page and from a mailbox's page, an admin can grant and revoke receive and send. Changes show in the audit log and take effect on the next request.

## Phase 8: Realtime, notifications and caches

_Revocation applies at once, everywhere_. Depends on: Phases 3, 6. Delivers: Hub, push and client cache changes.

1. On grant or revoke, signal the account's RealtimeHub so its clients refetch the mailbox list.
2. When sessions are revoked or the account is disabled, close the account's WebSockets in RealtimeHub.
3. Push notifications: only to accounts with receive on the mailbox; never subject or sender to others.
4. Client: clear the mailbox cache (clearMailboxesCache) on 403/404 and on the realtime 'grants changed' event.
5. Client: if the selected mailbox in localStorage is no longer granted, fall back to the first granted one.
6. Forwarding and webhooks move from the owner user to per-mailbox settings, admin-managed.
7. Auto-reply uses the mailbox's own settings, not the owner account's.
8. Spam settings and trash retention become mailbox-level, with the admin as editor.
9. The agent auto-draft reviewer must have receive+send on the mailbox (AI stays off in our deployment, but keep it correct).
10. Tests: revoke during an open session, then a list fetch, a WebSocket event and a push target all exclude the mailbox.

**Done when:** Revoking receive stops new-mail events and push for that mailbox within seconds, open tabs drop the mailbox on their next refresh, and a revoked session's WebSocket is closed.

## Phase 9: Tests and verification

_Prove account A can never reach mailbox B_. Depends on: Phases 2–8. Delivers: tests/access-*.test.mjs, run in CI.

1. Test helper: seed accounts A and B, mailboxes X and Y, with grants A→X (receive+send) and B→Y (receive).
2. Authz matrix: for each route in the inventory, A on Y gets 403/404, and B on Y can read but not send.
3. R2 paths: original .eml and attachment downloads for another mailbox's message → 404.
4. Send matrix: forged From, an alias of Y, a v1 API key scoped to Y but held by A, and JMAP submission.
5. Session tests: password reset, disable and revoke end sessions; TOTP is required before mail APIs.
6. Migration test: today's single-admin data → 0061 → the admin still sees all mailboxes and every message count is unchanged.
7. Audit test: every admin action writes exactly one audit row with actor, target and timestamp.
8. Fix or quarantine the 3 upstream tests already failing, and document why.
9. Add a GitHub Actions workflow in the fork (node 22, node --test tests/*.test.mjs, build).
10. QA dry run on a staging worker before production.

**Done when:** The authz matrix passes for every route in the inventory, the migration test passes, and the fork's CI runs node --test on every push.

## Phase 10: Rollout and upstream policy

_Ship safely, keep taking upstream fixes_. Depends on: Phase 9. Delivers: Production rollout + docs/picanteverde-upstream.md.

1. Deploy to a staging worker (mailflare-staging, its own D1 copy, no email routing) and run QA's checks there.
2. Back up production: a D1 export to R2 picanteverde-dev/backups before migrating.
3. Production deploy from a tagged fork commit; apply 0061 via the admin migrations endpoint; verify counts.
4. QA outside checks: authz matrix sample against production, WAF rules A/B still in place, Turnstile and TOTP enforced.
5. picanteverde creates the first extra accounts and grants; confirm with a real inbound and outbound mail per account.
6. Upstream policy: watch hieunc229/mailflare releases and security advisories, with a weekly check by the bot.
7. Sync procedure: rebase the fork's 'picanteverde' branch onto upstream on a branch, run the full test suite, and have QA review the diff before deploy.
8. Security fixes from upstream are cherry-picked within 48h, even if a full rebase is pending.
9. Keep our changes in few files (access.ts, sender.ts, accounts/*, admin pages) and note conflicts expected in each.
10. AGPL: keep the fork public, add a NOTICE describing our changes, and link the source from the app footer.

**Done when:** Production runs the new build, QA's outside checks pass, picanteverde has created accounts and grants, and the upstream sync process is written down and tried once.

---
Scope note: this rebuilds what upstream sells as Pro/Team. The AGPL allows it; this fork stays public.
