# picanteverde fork: access inventory (Phase 4)

Every API route that touches mailbox data, the action it needs (design note §2) and how it is enforced.
R = receive, S = send, A = admin. **Admin route** = must call `can(…, 'admin')` / `getAdminMailboxAccess`, never `getMailboxAccessLevel().canManage` (admins hold no mail grant).

Helpers (all in `src/lib/mailboxes/access.ts`, no cache, default deny):
`can()`, `getMailboxAccessLevel()` (null without R → 404), `getAdminMailboxAccess()` (A without a mail grant),
`canReadMessage()` (R; drafts: author + S), `mailboxScope()` (no ids → matches nothing), `draftVisibility()` (others' drafts never listed), `listAccessibleMailboxIds(…, 'send')`, `loadMailboxGrants()`.

## Mail

| Route | Method | Needs | Enforced by | Admin route | ✔ |
|---|---|---|---|---|---|
| /api/messages | GET | R per mailbox; drafts: author+S | `mailboxScope` + `draftVisibility` (no `messages.user_id` fallback) | | ✔ |
| /api/messages/counts | GET | R | same | | ✔ |
| /api/messages/navigation | GET | R | same | | ✔ |
| /api/messages/[id] | GET | R; drafts author+S | `canReadMessage` | | ✔ |
| /api/messages/[id]/metadata | GET | R | `canReadMessage` | | ✔ |
| /api/messages/[id]/original | GET | R (before R2 read) | `canReadMessage` | | ✔ |
| /api/messages/[id]/attachments/[aid] | GET | R (before R2 read) | `getAttachmentForUser` → `canReadMessage` | | ✔ |
| /api/messages/[id]/thread | GET | R | one mailbox per thread, R checked; drafts/trash excluded | | ✔ |
| /api/messages/[id]/read, /star | POST | R | `canRead` | | ✔ |
| /api/messages/[id]/status | POST | R | `updateMessageStatusForUser` → `canOrganize` | | ✔ |
| /api/messages/[id]/snooze | POST/DELETE | R | `canOrganize` | | ✔ |
| /api/messages/[id]/cancel-schedule | POST | S | `canSend` | | ✔ |
| /api/messages/bulk | POST | R; `delete` = A | `canOrganize` / `canManage`; folder moves only within the folder's mailbox | | ✔ |
| /api/messages/empty | POST | A | `getAdminMailboxAccess` | ✔ | ✔ |
| /api/drafts | GET/POST | S; author | `mailboxScope(send ids)` + author; POST via `getAuthorizedSenderAddress` | | ✔ |
| /api/drafts/[id] (+ attachments) | GET/PATCH/DELETE | author + S | `userOwnsDraft` (async, re-checks S) | | ✔ |
| /api/send | POST | S | `getAuthorizedSenderAddress` (`canSend`) + `userOwnsDraft` | | ✔ |
| /api/templates (+[id]) | GET/POST/DELETE | author only | `messages.user_id` = author (templates are personal, not mailbox data) | | ✔ |
| /api/export/messages | GET | R on the mailbox | `getMailboxAccessLevel`; drafts excluded | | ✔ |
| /api/import/messages, /api/import/imap | POST | A | `getAdminMailboxAccess` | ✔ | ✔ |
| /api/folders | GET / POST | R / A | `getMailboxFolderAccess` / `getAdminMailboxAccess` | POST ✔ | ✔ |
| /api/drive/attachments | POST | S (trash/restore/delete) | `canSend`; mailbox-less rows denied | | ✔ |
| /api/drive/attachments/[id]/content | GET | R (before R2 read) | `getAttachmentForUser` | | ✔ |
| /api/shared-files/[id] | GET | public link | expiring token by design (outbound large attachments) | | ✔ |

## Mailbox settings (all admin routes)

| Route | Method | Needs | Enforced by | Admin route | ✔ |
|---|---|---|---|---|---|
| /api/mailboxes | GET | R (list) | `listAccessibleMailboxes`; `ensurePersonalMailbox` **removed** | | ✔ |
| /api/mailboxes | POST | A | upstream admin checks; creator gets R+S (interim, Phase 5) | Phase 5 | ◐ |
| /api/mailboxes/[id] | GET | R | `getMailboxAccessLevel` | | ✔ |
| /api/mailboxes/[id] | PATCH | A | `getAdminMailboxAccess` | ✔ | ✔ |
| /api/mailboxes/[id] | DELETE | A | `can(admin)` | ✔ | ✔ |
| /api/mailboxes/[id]/aliases | * | A | `getAdminMailboxAccess` | ✔ | ✔ |
| /api/mailboxes/[id]/avatar | POST | A | `getAdminMailboxAccess` | ✔ | ✔ |
| /api/mailboxes/[id]/access | * | A | Team-gated upstream route, writes kept in step | Phase 5 | ◐ |
| /api/routing-rules (+[id]) | * | A | `getAdminMailboxAccess` | ✔ | ✔ |
| /api/contacts | GET / PATCH | R / A | `getMailboxAccessLevel` / `getAdminMailboxAccess`; contacts **per mailbox** (0063: `contacts.mailbox_id`, every lookup scoped by it) | PATCH ✔ | ✔ |
| /api/contacts/avatar | POST/DELETE | A | `getAdminMailboxAccess` | ✔ | ✔ |
| /api/contacts/block | POST | A | `getAdminMailboxAccess` | ✔ | ✔ |
| /api/agent/settings | PUT | A | `getAdminMailboxAccess` (agent is off in this deployment) | ✔ | ✔ |
| /api/settings/trash-retention | PATCH | A | role check; cron applies only enabled admins' settings | ✔ | ✔ |
| /api/webhooks (+children) | * | A | primary admin (upstream) | ✔ | ✔ |
| /api/backups/[id]/download | GET | A, audited | primary admin + `backup.download` audit row | ✔ | ✔ |
| /api/backups/restore | POST | A, audited | primary admin + `backup.restore` audit row (Phase 2) | ✔ | ✔ |

## API keys, protocols, background work

| Path | Needs | Enforced by | ✔ |
|---|---|---|---|
| `lib/api/key-auth.ts` (every key request) | key scope ∩ current grants; enabled account | re-read per request; `mailboxIds` intersected with R grants | ✔ |
| /api/v1/messages | R | `mailboxScope` + `draftVisibility`, key scope | ✔ |
| /api/v1/send | S | `sendEmail` → `getAuthorizedSenderAddress` | ✔ |
| JMAP Email/get, query, changes | R; drafts author+S | `scope()` = `mailboxScope` + `draftVisibility` | ✔ |
| JMAP Email/set update (keywords, moves) | R (moves: R on source and target) | `accessible` set | ✔ |
| JMAP Email/set create | S | `canSend` | ✔ |
| JMAP Email/set destroy | Trash→gone A; draft author+S; else → Trash R | per-row rule | ✔ |
| JMAP Email/import | A | `canManage` | ✔ |
| JMAP Mailbox rights, folder create/rename/delete | R / S / A | `canSend`, `canManage` from the grant and current role (never the permission label) | ✔ |
| JMAP EmailSubmission, Identity | S; author's draft | `canSend` + draft author check | ✔ |
| MCP tools | R / S per tool | `listAccessibleMailboxes` ∩ key scope; agent tools `requireAccess` | ✔ |
| Realtime revision, notifications | R | grant-only SQL (Phase 3) | ✔ |
| Outbound queue (`processOutboundQueue`) | S at dequeue | `can(send)`; job + message marked failed, no retry | ✔ |
| Agent jobs / approvals | reviewer R+S, author draft | `canSendOnBehalf` (= send) re-checked per job | ✔ |
| Trash retention cron | A | only enabled admins' settings | ✔ |

## Not mailbox data (no grant needed)

Auth and session (`/api/auth/*`, `/api/settings/mfa/*`, password, profile, shortcuts, time zone), the account's own avatar, calendar and booking (personal), Drive items (owner/share model, not mail), push subscriptions, licenses, branding, setup (WAF-blocked), and domain, AWS, Resend and account administration (admin; account/grant APIs are Phases 5–7).

## Known follow-ups

- Phase 5: replace `/api/mailboxes/[id]/access` and creator grants with the admin grants API.
- Phase 7: last-admin protection; API keys die with "revoke sessions" (`users.sessions_revoked_at`); granular admin flags (QA note): remove or map.
- Audit phase: upstream `email.send` audit metadata includes the subject. The design note says subjects are never logged, so drop it there.

Contacts (names, blocks, avatars, lastSeenAt, the spam engine's block lookup, list/thread sender names) are keyed by mailbox since 0063; `grep -rn "contacts.userId" src` is empty.

`grep -rn "messages.userId" src` now shows only author checks (drafts, templates, agent draft tools) and the trash-retention cron (admins only); `mailboxes.userId` is used only as a storage key (contacts, folders, imports), never as an access rule.
