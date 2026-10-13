import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { canReadMessage } from "@/lib/mailboxes/access";
import type { MessageOriginalRouteParams } from "./types";

export async function GET(request: Request, { params }: MessageOriginalRouteParams) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return new Response("Unauthorized", { status: 401 });

	const { messageId } = await params;
	const db = getDb(env);
	const [message] = await db
		.select({ mailboxId: messages.mailboxId, rawR2Key: messages.rawR2Key, userId: messages.userId, status: messages.status })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	// picanteverde fork: checked before anything is read from R2.
	if (!message || !(await canReadMessage(db, user, message))) return new Response("Message not found", { status: 404 });
	if (!message.rawR2Key) {
		return new Response("Original source was not retained for this message.", { status: 404 });
	}

	const object = await env.BUCKET.get(message.rawR2Key);
	if (!object) return new Response("Original source is unavailable.", { status: 404 });
	return new Response(object.body, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
}
