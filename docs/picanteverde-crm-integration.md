# CRM integration: what mailflare needs to add

_picanteverde fork of mailflare: dependency PRD for the base CRM module
([CRM PRD](https://github.com/picanteverde/base-picanteverde/blob/main/base/docs/modules/crm/PRD.md) §8, specs 04, 06, 08)._

Status: draft, for QA review. Docs only; each change below ships as its own PR on `picanteverde`, through
staging first, like the access rework.

## What already exists (verified in code, 2026-10-20)

| Need | Today | Evidence |
|---|---|---|
| Send as a mailbox from a service | `POST /api/v1/send`, Bearer key with `send` scope, `html` + `text`, `inReplyTo`/`references`, attachments | `src/app/api/v1/send/route.ts`, `src/lib/validators.ts` |
| Key limited to one mailbox | Settings > API keys binds each mail key to 1–30 mailboxes; the route returns 404 for others; From must be one of that mailbox's addresses | `route.ts:29`, `src/lib/email/sender.ts:52` |
| Account hygiene | keys stop working when the user is disabled, lacks TOTP, or revoked sessions after key creation | `src/lib/api/key-auth.ts:28-32` |
| Reply threading | inbound In-Reply-To/References matched to the stored provider Message-ID; inbound webhook carries `threadId` | `src/lib/email/threading.ts:49-62` |
| Webhooks | `message.inbound`, `message.outbound`, `message.failed`; per-webhook secret; HMAC-SHA256 of the body in `X-Email-Platform-Signature`; 5 attempts, exponential backoff via queue | `src/lib/email/webhooks.ts` |
| Search/read by key | `GET /api/v1/messages?q=` with `read` scope, limited to the key's mailboxes | `src/app/api/v1/messages/route.ts` |

## Gaps (what this PRD asks for)

### M1. Allow-listed custom headers on `/api/v1/send`
CRM must send RFC 8058 one-click unsubscribe. Add an optional `headers` object accepting **only**:
`List-Unsubscribe`, `List-Unsubscribe-Post` (value exactly `List-Unsubscribe=One-Click`), `List-Id`,
`Feedback-ID`. Any other name → 400 `header_not_allowed` (never silently dropped). Values: no CR/LF
(header injection), ≤ 1,000 chars, `List-Unsubscribe` must contain an `https:` URL. The existing
identity-header block in `sendEmail` stays.

### M2. Richer send response + idempotency
- Return `{ messageId, providerMessageId, threadId }` (both are already stored, `send.ts:234-235`).
- Accept `Idempotency-Key` (≤ 100 chars, per key, kept 24 h): a repeat returns the first response and sends
  nothing. CRM retries after timeouts must never double-send.

### M3. Per-key send caps (backstop)
CRM enforces its own warm-up caps; mailflare adds a hard backstop per key: `dailyCap` (default 50, set
when the key is created) and 10 sends/min. Over cap → 429 `send_cap_reached` with `Retry-After`. A bug in
CRM can then never blast the outreach domain.

### M4. Replay-safe webhook signatures
Today the HMAC covers only the body, so a captured delivery can be replayed. Add
`X-Email-Platform-Timestamp` (unix seconds) and sign `"{timestamp}.{rawBody}"` in a new
`X-Email-Platform-Signature-V2`; keep the old header during a transition. Receivers (CRM) reject a
timestamp older than 300 s and dedupe on `X-Email-Platform-Delivery`. Document the verification snippet.

### M5. Webhook scope and payloads
- **Mailbox filter:** today webhooks are per user and only the primary admin can create them. Add an optional
  `mailboxIds` filter so the admin can create a webhook that receives events **only** for
  `picante@outreach.picanteverde.com`, without CRM ever seeing the admin's other mail.
- **Payloads:** `message.inbound` adds `inReplyTo`, `references`, `mailboxId`; `message.outbound` adds
  `threadId`, `mailboxId`, `subject`. Bodies are **not** pushed: CRM fetches a reply with its `read`-scoped,
  mailbox-bound key (M6).
- Webhook URLs: `https` only, no IP literals or private ranges, no redirects followed (SSRF).

### M6. Read one message by key
Add `GET /api/v1/messages/{id}` (`read` scope, key's mailboxes only, 404 otherwise) returning headers,
`text`, and the **DOMPurify-sanitized** `html` the webmail already produces. CRM shows text by default and
the sanitized HTML only in its sandboxed, CSP-locked iframe (CRM spec 04).

### M7. Bounces and complaints (needs investigation first)
Nothing in mailflare handles bounces or complaints today; `message.failed` is only a send-time error, and an
asynchronous bounce, if it reaches us at all, arrives as a normal inbound message. CRM's auto-pause
(spec 06) depends on these signals, so:
1. **Investigate** what Cloudflare Email Sending exposes for messages sent with the `cf-bounce.outreach…`
   Return-Path (bounce notifications to us? an events API? nothing?). Result goes back to QA before any build.
2. If DSNs reach the mailbox: parse RFC 3464 `multipart/report` (and ARF RFC 5965 complaints) on inbound,
   link them to the original by Message-ID, and emit `message.bounced` `{ messageId, kind: hard|soft,
   status, diagnostic }` / `message.complained` `{ messageId, source }`, not filing them in the inbox.
3. Known limit to state in CRM: Gmail sends no per-message complaints (Postmaster Tools is aggregate only),
   so per-message complaint data will be partial; unsubscribes and replies remain the main signals.

## Out of scope
Suppression lists (CRM owns them and checks at send time), templates, tracking pixels/click tracking (not
wanted), sending from `info@`.

## Setup once built (all via admin UI, never chat)
1. A dedicated mailflare account `crm-service` (TOTP enrolled), granted **send + receive** on
   `picante@outreach.picanteverde.com` only.
2. A Settings > API key for it: scopes `send`, `read`, bound to that one mailbox, `dailyCap` per warm-up.
3. A primary-admin webhook to `https://crm.picanteverde.com/api/service/mail-events`, filtered to that
   mailbox, events inbound/outbound/failed (+ bounced/complained after M7).
4. Key and webhook secret stored in Teams config and set with `wrangler secret put` on the CRM worker.

## Acceptance criteria
1. `/api/v1/send` with `headers: { "X-Foo": "1" }` → 400 `header_not_allowed`; a `List-Unsubscribe` value with
   CR/LF → 400; a valid one appears in the sent message.
2. The same `Idempotency-Key` twice sends one email and returns the same ids.
3. The 51st send of the day on a key with `dailyCap: 50` → 429 `send_cap_reached`.
4. A webhook delivery replayed after 300 s fails CRM verification; the V2 signature covers the timestamp.
5. A mailbox-filtered webhook receives no events for other mailboxes.
6. `GET /api/v1/messages/{id}` for a message in another mailbox → 404.
7. M7 investigation result is written up before any bounce code is merged.
