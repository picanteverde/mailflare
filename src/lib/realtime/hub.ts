import { DurableObject } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getUserMailRevision } from "./revision";
import type { NewMessageNotification, AgentDraftNotification, RevisionPing, RevisionNotification } from "./types";

export class RealtimeHub extends DurableObject<CloudflareEnv> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/connect") {
			if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
				return new Response("Expected WebSocket upgrade", { status: 426 });
			}

			const pair = new WebSocketPair();
			const client = pair[0];
			const server = pair[1];
			const userId = request.headers.get("X-Mailflare-Realtime-User");
			if (!userId) return new Response("Unauthorized", { status: 401 });
			this.ctx.acceptWebSocket(server);
			server.serializeAttachment({ userId, connectedAt: Date.now() });

			return new Response(null, { status: 101, webSocket: client });
		}

		// picanteverde fork: "revoke sessions" closes every live socket of this account.
		if (url.pathname === "/revoke" && request.method === "POST") {
			for (const socket of this.ctx.getWebSockets()) socket.close(4001, "Session revoked");
			return new Response(null, { status: 204 });
		}

		if (url.pathname === "/notify" && request.method === "POST") {
			const payload = (await request.json()) as NewMessageNotification | AgentDraftNotification;
			const message = JSON.stringify(payload);

			for (const socket of this.ctx.getWebSockets()) {
				try {
					socket.send(message);
				} catch {
					socket.close(1011, "Delivery failed");
				}
			}

			return new Response(null, { status: 204 });
		}

		return new Response("Not found", { status: 404 });
	}

	async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (message === "ping") {
			socket.send("pong");
			return;
		}
		if (typeof message !== "string") return;
		let ping: RevisionPing;
		try {
			ping = JSON.parse(message) as RevisionPing;
		} catch {
			return;
		}
		if (ping.type !== "ping") return;
		const userId = socket.deserializeAttachment() as { userId?: string; connectedAt?: number } | null;
		if (!userId?.userId) return;
		// picanteverde fork: a socket outlives neither a disable nor a revocation.
		const [account] = await getDb(this.env).select({ disabled: users.disabled, revokedAt: users.sessionsRevokedAt }).from(users).where(eq(users.id, userId.userId)).limit(1);
		if (!account || account.disabled || (account.revokedAt && (userId.connectedAt ?? 0) <= account.revokedAt.getTime())) {
			socket.close(4001, "Session revoked");
			return;
		}
		try {
			const revision = await getUserMailRevision(this.env, userId.userId);
			const notification: RevisionNotification = { type: "revision", revision, changed: ping.revision !== null && ping.revision !== revision };
			socket.send(JSON.stringify(notification));
		} catch {
			socket.close(1011, "Revision lookup failed");
		}
	}
}
