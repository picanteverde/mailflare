import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// picanteverde fork, Phase 8b: settings that hung off the mailbox owner.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-access-settings-"));
after(() => rmSync(directory, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { sendMailboxAutoReply } from "./src/lib/email/auto-reply.ts";
			export { getAccountForwardingDestination } from "./src/lib/email/account-forwarding.ts";
			export { POST as sendRoute } from "./src/app/api/send/route.ts";
			export { POST as createWebhook } from "./src/app/api/webhooks/route.ts";
			export { PATCH as updateWebhook, DELETE as deleteWebhook } from "./src/app/api/webhooks/[id]/route.ts";
			export { POST as restoreRoute } from "./src/app/api/backups/restore/route.ts";
		`,
		resolveDir: root,
		sourcefile: "access-settings-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "next/headers": "next/headers.js", "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const m = await import(pathToFileURL(join(directory, "entry.mjs")).href);
const ORIGIN = "https://mailflare.test";

async function fixture(t) {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await m.applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, totp_enabled, forwarding_email, created_at) VALUES
			('admin', 'admin@ex.com', 'x', 'Admin', 'admin', 1, 1, 'outside@elsewhere.z', 1),
			('alice', 'alice@ex.com', 'x', 'Alice', 'user', 0, 1, NULL, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, sending_provider, receiving_provider, created_at) VALUES ('d', 'admin', 'ex.com', 'manual', 'active', 'cloudflare', 'none', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, display_name, auto_reply_enabled, auto_reply_subject, auto_reply_body, created_at)
			VALUES ('sales', 'admin', 'd', 'sales', 'Sales', 1, 'Away', 'Back Monday', 1);
		-- The owner (admin) holds no grant; alice may only read.
		INSERT INTO mailbox_access (id, mailbox_id, user_id, can_receive, can_send, created_at) VALUES ('g', 'sales', 'alice', 1, 0, 1);
	`);
	const sent = [];
	const env = { DB: database, MAILFLARE_RUNTIME: "node", EMAIL: { send: async (message) => { sent.push(message); return { messageId: `<m${sent.length}@ex.com>` }; } } };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	t.mock.method(globalThis, "fetch", async () => { throw new Error("tests must never contact a real service"); });
	const sessions = { admin: await m.createSession(env, "admin"), alice: await m.createSession(env, "alice") };
	const req = (user, path, method, body) => new Request(`${ORIGIN}${path}`, { method, headers: { Authorization: `Bearer ${sessions[user]}`, "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify(body) });
	return { database, env, sent, req };
}

test("the mailbox auto-replies by itself, though its owner holds no grant", async (t) => {
	const f = await fixture(t);
	await m.sendMailboxAutoReply(f.env, { mailboxId: "sales", userId: "admin", deliveredAddress: "sales@ex.com", fromAddress: "client@outside.z", incomingMessageId: "<in@outside.z>", headers: {} });
	assert.equal(f.sent.length, 1);
	assert.match(JSON.stringify(f.sent[0].from), /sales@ex\.com/);
	assert.equal(f.sent[0].subject, "Away");
});

test("users can't claim the system path: a send request with extra fields is still checked", async (t) => {
	const f = await fixture(t);
	const response = await m.sendRoute(f.req("alice", "/api/send", "POST", { mailboxId: "sales", from: "sales@ex.com", to: "x@y.z", subject: "s", text: "t", system: true, systemSends: true }));
	assert.equal(response.status, 403);
	assert.equal(f.sent.length, 0);
});

test("account-level forwarding is off (it followed the owner, i.e. every mailbox)", async (t) => {
	const f = await fixture(t);
	// Even with a license that enables forwarding upstream.
	f.database.db.exec("INSERT OR REPLACE INTO license_settings (id, instance_id, plan, state, features, updated_at) VALUES ('default', 'test', 'team', 'active', '[]', 1)");
	assert.equal(await m.getAccountForwardingDestination(f.env, "sales@ex.com"), null);
});

test("webhook create, update and delete are audited, never with the secret", async (t) => {
	const f = await fixture(t);
	const created = await (await m.createWebhook(f.req("admin", "/api/webhooks", "POST", { url: "https://hooks.example.z/in", events: ["message.inbound"] }))).json();
	const params = { params: Promise.resolve({ id: created.id }) };
	assert.equal((await m.updateWebhook(f.req("admin", `/api/webhooks/${created.id}`, "PATCH", { rotateSecret: true, enabled: false }), params)).status, 200);
	assert.equal((await m.deleteWebhook(f.req("admin", `/api/webhooks/${created.id}`, "DELETE"), params)).status, 200);
	const rows = f.database.db.prepare("SELECT action, metadata FROM audit_logs WHERE action LIKE 'webhook.%' ORDER BY rowid").all();
	assert.deepEqual(rows.map((row) => row.action), ["webhook.create", "webhook.update", "webhook.delete"]);
	for (const row of rows) assert.doesNotMatch(row.metadata, new RegExp(created.secret));
	assert.deepEqual(JSON.parse(rows[1].metadata).secretRotated, true);
	assert.equal((await m.createWebhook(f.req("alice", "/api/webhooks", "POST", { url: "https://x.z", events: ["message.inbound"] }))).status, 403);
});

test("webhook audit rows carry the host only, never a secret path or query", async (t) => {
	const f = await fixture(t);
	const secretUrl = "https://hooks.slack.example/services/T000SECRETPATH/B111/xoxsecretvalue?token=querysecret123";
	const created = await (await m.createWebhook(f.req("admin", "/api/webhooks", "POST", { url: secretUrl, events: ["message.inbound"] }))).json();
	const params = { params: Promise.resolve({ id: created.id }) };
	const rotatedUrl = "https://discord.example/api/webhooks/12345/anothertokenvalue?x=othersecret";
	assert.equal((await m.updateWebhook(f.req("admin", `/api/webhooks/${created.id}`, "PATCH", { url: rotatedUrl }), params)).status, 200);
	const metadata = f.database.db.prepare("SELECT group_concat(metadata, ' ') AS all_ FROM audit_logs WHERE action LIKE 'webhook.%'").get().all_;
	for (const secret of ["SECRETPATH", "xoxsecretvalue", "querysecret123", "services", "anothertokenvalue", "othersecret", "/api/webhooks"]) {
		assert.doesNotMatch(metadata, new RegExp(secret), secret);
	}
	assert.match(metadata, /hooks\.slack\.example/);
	assert.match(metadata, /discord\.example/);
	assert.match(metadata, /"urlChanged":true/);
});

test("in-app restore is off and points to the runbook; a disabled account's send is 401", async (t) => {
	const f = await fixture(t);
	const response = await m.restoreRoute(f.req("admin", "/api/backups/restore", "POST", {}));
	assert.equal(response.status, 410);
	assert.equal((await response.json()).code, "restore_disabled");
	f.database.db.exec("UPDATE users SET disabled = 1 WHERE id = 'alice'");
	assert.equal((await m.sendRoute(f.req("alice", "/api/send", "POST", { mailboxId: "sales", from: "sales@ex.com", to: "x@y.z", subject: "s", text: "t" }))).status, 401);
	assert.equal(f.sent.length, 0);
});
