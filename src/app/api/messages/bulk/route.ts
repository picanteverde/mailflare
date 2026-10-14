import { eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { folders, messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { permanentlyDeleteMessages } from "@/lib/email/permanent-delete";
import { applySpamFeedback } from "@/lib/spam/feedback";
import type { BulkMessagePayload } from "./types";
import {
	getReadValueForBulkAction,
	getStatusForBulkAction,
	isAllowedBulkMessageAction,
	isPermanentlyDeletableStatus,
} from "./utils";

export async function POST(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const payload = (await request.json()) as BulkMessagePayload;
	const messageIds = payload.messageIds?.filter(Boolean) ?? [];
	if (messageIds.length === 0 || !isAllowedBulkMessageAction(payload.action)) {
		return NextResponse.json({ error: "Invalid bulk message action" }, { status: 400 });
	}

	const status = getStatusForBulkAction(payload.action);
	const read = getReadValueForBulkAction(payload.action);
	const db = getDb(env);
	let folderId: string | null | undefined;
	let folderMailboxId: string | null = null;

	if (payload.action === "folder") {
		if (!payload.folderId) {
			return NextResponse.json({ error: "Folder is required" }, { status: 400 });
		}
		const [folder] = await db
			.select({ id: folders.id, mailboxId: folders.mailboxId })
			.from(folders)
			.where(eq(folders.id, payload.folderId))
			.limit(1);
		if (!folder) {
			return NextResponse.json({ error: "Folder not found" }, { status: 404 });
		}
		const folderAccess = await getMailboxAccessLevel(db, user, folder.mailboxId);
		if (!folderAccess?.canOrganize) {
			return NextResponse.json({ error: "Folder not found" }, { status: 404 });
		}
		folderId = folder.id;
		folderMailboxId = folder.mailboxId;
	} else if (payload.action === "spam" || payload.action === "trash" || payload.action === "inbox" || payload.action === "archive") {
		folderId = null;
	}

	const values = {
		...(status ? { status } : {}),
		...(read !== null ? { read } : {}),
		...(folderId !== undefined ? { folderId } : {}),
		...(payload.action === "inbox" ? { snoozedUntil: null } : {}),
	};

	if (payload.action !== "delete" && Object.keys(values).length === 0) {
		return NextResponse.json({ error: "No changes requested" }, { status: 400 });
	}

	const selectedMessages = await db.select().from(messages).where(inArray(messages.id, messageIds));
	const allowedMessageIds: string[] = [];

	for (const message of selectedMessages) {
		if (!message.mailboxId) continue;
		// picanteverde fork: a folder belongs to one mailbox; mail from another mailbox is skipped.
		if (folderMailboxId && message.mailboxId !== folderMailboxId) continue;
		const access = await getMailboxAccessLevel(db, user, message.mailboxId);
		// picanteverde fork: organizing needs receive; destroying mail is admin-only (access design §2).
		const canUpdate = payload.action === "delete" ? access?.canManage : access?.canOrganize;
		if (!canUpdate) continue;
		// picanteverde fork: "unarchive" only restores archived mail (it is the Undo of archive).
		if (payload.action === "unarchive" && message.status !== "archived") continue;
		allowedMessageIds.push(message.id);
	}

	if (allowedMessageIds.length === 0) {
		return NextResponse.json({ error: "No accessible messages" }, { status: 404 });
	}
	// picanteverde fork: audit rows carry the mailbox, so per-mailbox views see bulk actions (QA on #18).
	const mailboxIdOf = new Map(selectedMessages.map((message) => [message.id, message.mailboxId]));
	if (payload.action === "delete") {
		// Only mail already in Trash or Spam can be destroyed; anything else is skipped.
		const deletable = selectedMessages.filter(
			(message) => allowedMessageIds.includes(message.id) && isPermanentlyDeletableStatus(message.status),
		);
		const deleted = await permanentlyDeleteMessages(env, db, user.id, deletable, "bulk");
		return NextResponse.json({ ok: true, deleted, skipped: allowedMessageIds.length - deleted });
	}
	if (payload.action === "spam") {
		for (const messageId of allowedMessageIds) await applySpamFeedback(env, user, messageId, "spam");
		return NextResponse.json({ ok: true });
	}
	if (payload.action === "inbox") {
		const spamMessageIds = selectedMessages.filter((message) => message.status === "spam" && allowedMessageIds.includes(message.id)).map((message) => message.id);
		const normalMessageIds = allowedMessageIds.filter((messageId) => !spamMessageIds.includes(messageId));
		for (const messageId of spamMessageIds) await applySpamFeedback(env, user, messageId, "ham");
		if (normalMessageIds.length) await db.update(messages).set(values).where(inArray(messages.id, normalMessageIds));
		// picanteverde fork: moving back to the inbox is audited like every other move (spam
		// messages above are already logged as email.spam_feedback).
		await Promise.all(
			normalMessageIds.map((messageId) =>
				createAuditLog(env, { actorUserId: user.id, mailboxId: mailboxIdOf.get(messageId) ?? null, messageId, action: "email.move", metadata: { bulkAction: payload.action } }),
			),
		);
		return NextResponse.json({ ok: true });
	}

	await db.update(messages).set(values).where(inArray(messages.id, allowedMessageIds));
	await Promise.all(
		allowedMessageIds.map((messageId) =>
			createAuditLog(env, {
				actorUserId: user.id,
				mailboxId: mailboxIdOf.get(messageId) ?? null,
				messageId,
				// picanteverde fork: moves were logged as email.delete; real deletes return earlier.
				action: payload.action === "read" || payload.action === "unread" ? "email.read" : "email.move",
				metadata: { bulkAction: payload.action },
			}),
		),
	);

	return NextResponse.json({ ok: true });
}
