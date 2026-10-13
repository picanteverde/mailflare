import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages, outboundJobs } from "@/db/schema";
import { can } from "@/lib/mailboxes/access";
import { newId } from "@/lib/ids";
import { buildSnippet } from "@/lib/email/parse";
import { dispatchWebhooks } from "@/lib/email/webhooks";
import { upsertContactFromAddress } from "@/lib/contacts/service";
import { getAuthorizedSenderAddress } from "@/lib/email/sender";
import { getEmailAddressList, joinEmailAddressList, splitEmailAddressList } from "@/lib/email/address";
import { formatMessageIdHeader, normalizeMessageId, parseMessageIdList } from "@/lib/email/threading";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { loadMessageAttachmentContents, storeMessageAttachments, validateAttachments } from "@/lib/email/attachments";
import type { AttachmentContent } from "@/lib/email/attachment-types";
import { getOutboundAttachmentMaxMb } from "@/lib/email/attachment-policy";
import { getOutboundProviderConfig, sendThroughProvider } from "@/lib/email/outbound-provider";
import { prepareCloudflareAttachments } from "@/lib/email/cloud-attachment-utils";

export type SendEmailInput = {
	userId: string;
	from: string;
	/** One header-style list or an array; each entry may carry a display name. */
	to: string | string[];
	cc?: string | string[];
	bcc?: string | string[];
	subject: string;
	html?: string;
	text?: string;
	headers?: Record<string, string>;
	/** Message-ID of the message being replied to, with or without angle brackets. */
	inReplyTo?: string | null;
	/** References chain, as a header string or a list of Message-IDs. */
	references?: string | string[] | null;
	/** Conversation to file the sent copy under; defaults to its own Message-ID. */
	threadId?: string | null;
	mailboxId: string;
	attachments?: AttachmentContent[];
	/** Future delivery time. Values at or before the current time send immediately. */
	scheduledAt?: string | Date;
	publicOrigin?: string;
};

const MAX_RECIPIENTS = 50;
const MAX_QUEUE_DELAY_SECONDS = 24 * 60 * 60;

type PreparedDelivery = {
	input: SendEmailInput;
	messageId: string;
	jobId: string;
	from: string;
	mailboxId: string;
	to: string[];
	cc: string[];
	bcc: string[];
	headers: Record<string, string>;
	attachments: AttachmentContent[];
};

function toRecipientList(value: string | string[] | undefined): string[] {
	const entries = Array.isArray(value) ? value : splitEmailAddressList(value);
	const seen = new Set<string>();
	const result: string[] = [];
	for (const entry of entries) {
		const [address] = getEmailAddressList(entry);
		if (!address || seen.has(address)) continue;
		seen.add(address);
		result.push(entry.trim());
	}
	return result;
}

export async function sendEmail(
	env: CloudflareEnv,
	input: SendEmailInput,
): Promise<{ messageId: string; scheduled?: boolean }> {
	const db = getDb(env);
	const sender = await getAuthorizedSenderAddress(env, input);
	const attachments = input.attachments ?? [];
	validateAttachments(attachments);
	const maxAttachmentMb = await getOutboundAttachmentMaxMb(env);
	const maxAttachmentBytes = maxAttachmentMb * 1_000_000;
	if (attachments.some((attachment) => attachment.content.byteLength > maxAttachmentBytes) ||
		attachments.reduce((total, attachment) => total + attachment.content.byteLength, 0) > maxAttachmentBytes) {
		throw new Error(`Attachments exceed the administrator's ${maxAttachmentMb} MB outgoing limit`);
	}
	if (input.subject.length > 998) throw new Error("Subject exceeds Cloudflare's 998-character limit");

	const to = toRecipientList(input.to);
	const cc = toRecipientList(input.cc);
	const bcc = toRecipientList(input.bcc);
	if (to.length === 0) throw new Error("At least one recipient is required");
	if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
		throw new Error(`A message can have at most ${MAX_RECIPIENTS} recipients`);
	}
	for (const address of [...to, ...cc, ...bcc]) {
		await upsertContactFromAddress(env, { userId: input.userId, mailboxId: sender.mailboxId, address, source: "outbound" });
	}

	const inReplyTo = normalizeMessageId(input.inReplyTo);
	const references = Array.isArray(input.references)
		? input.references.map((id) => normalizeMessageId(id)).filter((id): id is string => !!id)
		: parseMessageIdList(input.references);
	assertNoIdentityHeaders(input.headers);
	const headers: Record<string, string> = { ...input.headers };
	if (inReplyTo) headers["In-Reply-To"] = `<${inReplyTo}>`;
	if (references.length > 0) headers.References = formatMessageIdHeader(references);
	if (new TextEncoder().encode(Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("")).byteLength > 16 * 1024) {
		throw new Error("Headers exceed Cloudflare's 16 KB limit");
	}

	const messageId = newId("msg");
	const requestedSchedule = input.scheduledAt ? new Date(input.scheduledAt) : null;
	const scheduledAt = requestedSchedule && requestedSchedule.getTime() > Date.now()
		? requestedSchedule
		: null;
	const snippet = buildSnippet(input.text ?? null, input.html ?? null);
	const toAddr = joinEmailAddressList(to);

	await db.insert(messages).values({
		id: messageId,
		userId: input.userId,
		mailboxId: sender.mailboxId,
		direction: "outbound",
		fromAddr: sender.fromAddr,
		toAddr,
		ccAddr: cc.length ? joinEmailAddressList(cc) : null,
		bccAddr: bcc.length ? joinEmailAddressList(bcc) : null,
		subject: input.subject,
		snippet,
		textBody: input.text ?? null,
		htmlBody: input.html ?? null,
		status: "queued",
		read: true,
		threadId: input.threadId ?? null,
		inReplyTo,
		references: references.length ? references.join(" ") : null,
	});
	try {
		const stored = await storeMessageAttachments(env, messageId, attachments);
		stored.forEach((attachment, index) => { attachments[index].storageId = attachment.id; });
	} catch (error) {
		await db.delete(messages).where(eq(messages.id, messageId));
		throw error;
	}

	const jobId = newId("job");
	await db.insert(outboundJobs).values({
		id: jobId,
		userId: input.userId,
		messageId,
		status: "queued",
		payload: JSON.stringify({
			...input,
			from: sender.fromAddr,
			to,
			cc,
			bcc,
			mailboxId: sender.mailboxId,
			attachments: attachments.map(({ content: _content, ...attachment }) => attachment),
		}),
		scheduledAt,
	});

	const delivery: PreparedDelivery = {
		input: { ...input, attachments: undefined },
		messageId,
		jobId,
		from: sender.fromAddr,
		mailboxId: sender.mailboxId,
		to,
		cc,
		bcc,
		headers,
		attachments,
	};
	if (scheduledAt) {
		await enqueueScheduledDelivery(env, delivery, scheduledAt);
		return { messageId, scheduled: true };
	}

	await deliverEmail(env, delivery);
	return { messageId };
}

async function deliverEmail(env: CloudflareEnv, delivery: PreparedDelivery): Promise<void> {
	const { input, messageId, jobId, from, mailboxId, to, cc, bcc, headers, attachments } = delivery;
	const db = getDb(env);
	const toAddr = joinEmailAddressList(to);
	try {
		const provider = await getOutboundProviderConfig(env, from);
		// Cloudflare's 5 MiB cap forces big files into download links; Resend takes
		// the attachments directly (the admin's outgoing limit still applies).
		const prepared = provider.provider === "cloudflare"
			? await prepareCloudflareAttachments(env, attachments, {
				subject: input.subject,
				html: input.html,
				text: input.text,
				headers,
				publicOrigin: input.publicOrigin,
			})
			: { attachments, html: input.html, text: input.text };
		if (prepared.text !== input.text || prepared.html !== input.html) {
			await db.update(messages).set({ textBody: prepared.text ?? null, htmlBody: prepared.html ?? null }).where(eq(messages.id, messageId));
		}
		const response = await sendThroughProvider(
			env,
			provider,
			{
				from,
				to,
				cc,
				bcc,
				subject: input.subject,
				headers,
				html: prepared.html,
				text: prepared.text,
				attachments: prepared.attachments.map((attachment) => ({
					filename: attachment.filename,
					type: attachment.type,
					content: attachment.content,
					disposition: attachment.disposition === "inline" && attachment.contentId ? "inline" : "attachment",
					contentId: attachment.contentId,
				})),
			},
			jobId,
		);

		// A fresh message starts its own conversation; Cloudflare's Message-ID is what
		// any reply will name in In-Reply-To, so key the thread by it.
		await db
			.update(messages)
			.set({
				status: "sent",
				providerMessageId: response.messageId,
				threadId: input.threadId ?? normalizeMessageId(response.messageId) ?? messageId,
			})
			.where(eq(messages.id, messageId));
		await db.update(outboundJobs).set({ status: "sent", updatedAt: new Date() }).where(eq(outboundJobs.id, jobId));

		await dispatchWebhooks(env, input.userId, "message.outbound", {
			messageId,
			providerMessageId: response.messageId,
			to: toAddr,
			cc: cc.length ? joinEmailAddressList(cc) : undefined,
		});
		await createAuditLog(env, {
			actorUserId: input.userId,
			mailboxId,
			messageId,
			action: "email.send",
			// picanteverde fork: ids only. Subjects, bodies and recipients are never logged (design §7).
			metadata: { mailboxId, messageId },
		});
	} catch (err) {
		const error = err instanceof Error ? err.message : "Send failed";
		await db.update(messages).set({ status: "failed" }).where(eq(messages.id, messageId));
		await db
			.update(outboundJobs)
			.set({ status: "failed", error, updatedAt: new Date() })
			.where(eq(outboundJobs.id, jobId));
		await dispatchWebhooks(env, input.userId, "message.failed", { messageId, error });
		throw err;
	}
}

export type OutboundQueueMessage = {
	kind: "email.scheduled";
	jobId: string;
	messageId: string;
	scheduledAt: string;
};

async function enqueueScheduledDelivery(
	env: CloudflareEnv,
	delivery: PreparedDelivery,
	scheduledAt: Date,
): Promise<void> {
	const delaySeconds = Math.min(
		MAX_QUEUE_DELAY_SECONDS,
		Math.max(1, Math.ceil((scheduledAt.getTime() - Date.now()) / 1000)),
	);
	await env.OUTBOUND_QUEUE.send(
		{
			kind: "email.scheduled",
			jobId: delivery.jobId,
			messageId: delivery.messageId,
			scheduledAt: scheduledAt.toISOString(),
		},
		{ delaySeconds },
	);
}

/**
 * picanteverde fork: callers may add protocol headers (auto-reply markers, threading),
 * never identity headers. From comes only from the authorized mailbox, and Sender,
 * Reply-To, Return-Path or Resent-* could otherwise impersonate another local mailbox.
 */
const IDENTITY_HEADERS = new Set(["from", "sender", "reply-to", "return-path", "envelope-from", "x-original-from"]);
function assertNoIdentityHeaders(headers: Record<string, string> | undefined) {
	for (const name of Object.keys(headers ?? {})) {
		const lower = name.trim().toLowerCase();
		if (IDENTITY_HEADERS.has(lower) || lower.startsWith("resent-")) throw new Error(`The ${name} header cannot be set`);
	}
}

export async function processOutboundQueue(
	env: CloudflareEnv,
	payload: OutboundQueueMessage,
): Promise<void> {
	const db = getDb(env);
	const [job] = await db
		.select({ status: outboundJobs.status, payload: outboundJobs.payload })
		.from(outboundJobs)
		.where(eq(outboundJobs.id, payload.jobId))
		.limit(1);
	if (!job || job.status !== "queued") return;
	const scheduledAt = new Date(payload.scheduledAt);
	const input = JSON.parse(job.payload) as SendEmailInput;
	const to = toRecipientList(input.to);
	const cc = toRecipientList(input.cc);
	const bcc = toRecipientList(input.bcc);
	const inReplyTo = normalizeMessageId(input.inReplyTo);
	const references = Array.isArray(input.references)
		? input.references.map((id) => normalizeMessageId(id)).filter((id): id is string => !!id)
		: parseMessageIdList(input.references);
	const headers: Record<string, string> = { ...input.headers };
	if (inReplyTo) headers["In-Reply-To"] = `<${inReplyTo}>`;
	if (references.length > 0) headers.References = formatMessageIdHeader(references);
	const delivery: PreparedDelivery = {
		input,
		messageId: payload.messageId,
		jobId: payload.jobId,
		from: input.from,
		mailboxId: input.mailboxId,
		to,
		cc,
		bcc,
		headers,
		attachments: [],
	};
	if (scheduledAt.getTime() > Date.now()) {
		await enqueueScheduledDelivery(env, delivery, scheduledAt);
		return;
	}
	// picanteverde fork: re-check at dequeue. A scheduled or retried send must not go out
	// after the author lost the send grant, or their account or the mailbox was disabled.
	if (!input.mailboxId || !(await can(db, { id: input.userId }, input.mailboxId, "send"))) {
		const error = "Sender no longer has send permission for this mailbox";
		await db.update(messages).set({ status: "failed" }).where(eq(messages.id, payload.messageId));
		await db.update(outboundJobs).set({ status: "failed", error, updatedAt: new Date() }).where(eq(outboundJobs.id, payload.jobId));
		return;
	}
	delivery.attachments = await loadMessageAttachmentContents(env, payload.messageId);
	await deliverEmail(env, delivery);
}
