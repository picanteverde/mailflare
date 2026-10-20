# M7 investigation: bounces and complaints from Cloudflare Email Sending

_picanteverde fork of mailflare. Research for [CRM integration M7](picanteverde-crm-integration.md#m7-bounces-and-complaints-needs-investigation-first).
No code and no infrastructure changes yet. QA reviews this before any bounce code (criterion 7)._

## Findings (Cloudflare docs, read 2026-10-20)

1. **Cloudflare already tracks bounces and complaints for us.** Email Sending publishes six events per
   message: `message.delivered`, `message.deferred`, `message.bounced`, `message.failed`, `message.rejected`,
   `message.complained` ([event subscriptions](https://developers.cloudflare.com/email-service/reference/event-subscriptions/)).
2. **They are delivered to a Cloudflare Queue, not a webhook.** A queue is subscribed to Email Sending events
   (dashboard: Queues › Subscriptions › Subscribe to events, or the API), scoped to **one sending domain**
   (the apex or one verified sending subdomain), with the event types chosen
   ([example](https://developers.cloudflare.com/email-service/examples/email-sending/sync-recipient-records/)).
   There is no public endpoint and no signature to verify: only our account's subscription can put events
   into our queue.
3. **Payload** (schema version 1): `type` (`cf.email.sending.message.bounced` …), `source { zoneId, domain }`,
   `payload { eventId, messageId, sender, recipient, subject?, terminal, delivery { status, smtpStatusCode,
   smtpEnhancedStatusCode, smtpResponse }, bounce { type: hard|soft, classification, reason } | complaint { type } }`,
   `metadata { accountId, eventSubscriptionId, eventSchemaVersion, eventTimestamp }`.
4. **Correlation:** the docs say the `messageId` returned by `env.EMAIL.send()` is the key that links a send
   to its later events. Mailflare already stores exactly that value as `providerMessageId` for Cloudflare
   sends (`src/lib/email/outbound-provider.ts:112-127`, `send.ts:234`). So no DSN parsing is needed.
5. **Cloudflare also suppresses automatically**, per sending domain: hard bounces (no expiry when the mailbox
   or domain doesn't exist, 7 days for other permanent rejections), soft bounces 24 h, complaints with no
   expiry ([suppressions](https://developers.cloudflare.com/email-service/concepts/suppressions/)). That is
   a second safety net under CRM's own suppression list, not a replacement (CRM suppressions are global
   across mailboxes and keep deletion hashes).
6. **Complaints:** the docs don't say which mailbox providers feed `message.complained`. Gmail does not send
   per-message complaints to senders (Postmaster Tools is aggregate only), so expect complaint events mainly
   from providers with feedback loops (e.g. Yahoo, Microsoft). CRM's complaint rule (spec 06) will see partial
   data. Unsubscribes and the bounce rule stay the main signals.

## Not confirmed by the docs (must be checked on staging)

- **V1.** Does the `env.EMAIL.send()` `messageId` equal the RFC 5322 `Message-ID` header recipients see? Mailflare's
  reply threading matches inbound `In-Reply-To` against `providerMessageId`. If the two differ, threading of
  replies to API sends needs the real header (store both). This matters for CRM reply detection either way.
- **V2.** Delivery semantics: Cloudflare Queues deliver **at least once**, so duplicates are possible; the consumer
  dedupes on `payload.eventId`. Ordering is not guaranteed (a `delivered` may arrive after a `bounced` retry
  sequence); state changes use `eventTimestamp` and never move a terminal state backwards.
- **V3.** Whether a send to a Cloudflare-suppressed address fails synchronously or emits `message.rejected`.

## Proposed design (for QA review; built only after approval, staging first)

1. **Queue + subscription:** `mailflare-email-events` (+ DLQ `mailflare-email-events-dlq`), subscribed for the
   sending domain `outreach.picanteverde.com` only, events `bounced`, `complained`, `failed`, `rejected`
   (`delivered`/`deferred` not needed in v1). Staging uses its own queue and its own test sending domain.
   Creating them is an infra change: listed record by record for QA before it's done.
2. **Consumer** in the existing `queue()` handler (`worker.ts:106`), new branch by queue name:
   - reject (ack + log) events whose `metadata.accountId` isn't ours or whose `source.domain` isn't configured;
   - `INSERT … ON CONFLICT(event_id) DO NOTHING` into a new `email_events` table
     (`event_id` unique, `message_id`, `type`, `recipient_hmac`, `at`, `data`), so duplicates do nothing;
   - look up the sent message by `providerMessageId`; unknown → keep the row, no webhook;
   - emit webhook `message.bounced` `{ messageId, providerMessageId, recipient, kind: hard|soft, smtpStatus,
     reason }` or `message.complained` `{ messageId, providerMessageId, recipient, kind }`, V2-signed (M4), to
     webhooks filtered to that mailbox (M5);
   - `ack()` on success, `retry()` on a transient DB error; poison messages go to the DLQ after 3 tries.
3. **No DSN/ARF parsing** of inbound mail in v1: not needed with events. If V1 shows bounces also reach the
   mailbox as DSNs, they stay ordinary inbound mail.
4. **Privacy:** `recipient` stored as HMAC in `email_events`; the plain address only travels in the signed
   webhook to CRM (which already holds it). Event rows kept 90 days.

## Staging test plan (needs QA's go-ahead, because it sends real mail)
1. Send one message from the staging sending domain to a mailbox we own → `delivered` event; compare
   `providerMessageId`, the event `messageId` and the received `Message-ID` header (answers V1).
2. Send one message to a nonexistent address at a domain we control (no third-party reputation impact) →
   `bounced` hard event → `message.bounced` webhook to a test receiver; deliver the same event twice by
   replaying it from the DLQ → one row, one webhook (V2).
3. Send again to the now-suppressed address → observe V3.
Complaints can't be triggered safely; the consumer path is covered by a unit test with the documented payload.

## Acceptance criteria (for the later build)
1. A duplicate `eventId` creates no second row and no second webhook.
2. An event with another `accountId` or an unconfigured `source.domain` is ignored.
3. A hard bounce for an API send produces one V2-signed `message.bounced` webhook with the original `messageId`.
4. A late `delivered` after a terminal `bounced` doesn't change the stored state.
5. Staging steps 1–3 are recorded (ids, headers redacted of addresses) before production.
