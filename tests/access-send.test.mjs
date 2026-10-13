import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// picanteverde fork, Phase 5: the send grant is enforced on the server for every From.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-access-send-"));
after(() => rmSync(directory, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { sendEmail } from "./src/lib/email/send.ts";
			export { POST as sendRoute } from "./src/app/api/send/route.ts";
			export { GET as listMailboxes } from "./src/app/api/mailboxes/route.ts";
		`,
		resolveDir: root,
		sourcefile: "access-send-test-entry.ts",
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

async function fixture(t) {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await m.applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, disabled, created_at) VALUES
			('admin', 'admin@ex.com', 'x', 'Admin', 'admin', 1, 0, 1),
			('reader', 'reader@ex.com', 'x', 'Reader', 'user', 0, 0, 1),
			('sender', 'sender@ex.com', 'x', 'Sender', 'user', 0, 0, 1),
			('gone', 'gone@ex.com', 'x', 'Disabled', 'user', 0, 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, sending_provider, created_at) VALUES ('d', 'admin', 'ex.com', 'manual', 'active', 'cloudflare', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, display_name, created_at) VALUES
			('sales', 'admin', 'd', 'sales', 'Sales Team', 1),
			('ceo', 'admin', 'd', 'ceo', 'The CEO', 1);
		INSERT INTO mailbox_aliases (id, mailbox_id, domain_id, local_part, created_at) VALUES ('a1', 'ceo', 'd', 'boss', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, can_receive, can_send, created_at) VALUES
			('g1', 'sales', 'reader', 1, 0, 1),
			('g2', 'sales', 'sender', 1, 1, 1),
			('g3', 'sales', 'gone', 1, 1, 1),
			('g4', 'ceo', 'reader', 1, 0, 1);
	`);
	const sent = [];
	const env = { DB: database, MAILFLARE_RUNTIME: "node", EMAIL: { send: async (message) => { sent.push(message); return { messageId: `<m${sent.length}@ex.com>` }; } } };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const sessions = {};
	for (const id of ["admin", "reader", "sender"]) sessions[id] = await m.createSession(env, id);
	const send = (user, body) => m.sendRoute(new Request("https://mailflare.test/api/send", {
		method: "POST",
		headers: { Authorization: `Bearer ${sessions[user]}`, "Content-Type": "application/json", Origin: "https://mailflare.test" },
		body: JSON.stringify({ to: "client@outside.z", subject: "Quote", text: "Hello", ...body }),
	}));
	return { database, env, sent, send };
}

test("only an account with the send grant can send, as the mailbox, from its own addresses", async (t) => {
	const f = await fixture(t);
	// No grant (admin manages but holds none), receive only: 403 and nothing leaves.
	assert.equal((await f.send("admin", { mailboxId: "sales", from: "sales@ex.com" })).status, 403);
	assert.equal((await f.send("reader", { mailboxId: "sales", from: "sales@ex.com" })).status, 403);
	// Forged From: another mailbox's address, or an alias of another mailbox, under a mailbox it can send from.
	assert.equal((await f.send("sender", { mailboxId: "sales", from: "ceo@ex.com" })).status, 403);
	assert.equal((await f.send("sender", { mailboxId: "sales", from: "boss@ex.com" })).status, 403);
	assert.equal((await f.send("sender", { mailboxId: "ceo", from: "ceo@ex.com" })).status, 403);
	assert.equal(f.sent.length, 0);

	// Allowed: the display name the client sends is replaced by the mailbox's own.
	const ok = await f.send("sender", { mailboxId: "sales", from: '"The CEO" <sales@ex.com>' });
	assert.equal(ok.status, 200);
	assert.equal(f.sent.length, 1);
	assert.match(f.sent[0].from.email ?? f.sent[0].from, /sales@ex\.com/);
	assert.doesNotMatch(JSON.stringify(f.sent[0].from), /The CEO/);
	assert.doesNotMatch(JSON.stringify(f.sent[0].from), /on behalf of/);

	// The audit row records ids only: no subject, recipients or body.
	const audit = f.database.db.prepare("SELECT actor_user_id AS actor, mailbox_id AS mailbox, metadata FROM audit_logs WHERE action = 'email.send'").get();
	assert.equal(audit.actor, "sender");
	assert.equal(audit.mailbox, "sales");
	assert.doesNotMatch(audit.metadata, /Quote|Hello|client@outside/);

	// Revoking send applies to the next request.
	f.database.db.exec("UPDATE mailbox_access SET can_send = 0 WHERE id = 'g2'");
	assert.equal((await f.send("sender", { mailboxId: "sales", from: "sales@ex.com" })).status, 403);
	assert.equal(f.sent.length, 1);
});

test("a disabled account cannot send, and callers cannot set identity headers", async (t) => {
	const f = await fixture(t);
	await assert.rejects(m.sendEmail(f.env, { userId: "gone", mailboxId: "sales", from: "sales@ex.com", to: "x@y.z", subject: "s", text: "t" }), /Sender account not found/);
	for (const name of ["Reply-To", "Sender", "From", "Return-Path", "Resent-From", "reply-to", "To", "Cc", "BCC", "DKIM-Signature", "ARC-Seal", "ARC-Authentication-Results", "Authentication-Results", "Received-SPF"]) {
		await assert.rejects(
			m.sendEmail(f.env, { userId: "sender", mailboxId: "sales", from: "sales@ex.com", to: "x@y.z", subject: "s", text: "t", headers: { [name]: "ceo@ex.com" } }),
			/header cannot be set/,
			name,
		);
	}
	assert.equal(f.sent.length, 0);
	// Protocol headers (auto-reply markers) still pass.
	await m.sendEmail(f.env, { userId: "sender", mailboxId: "sales", from: "sales@ex.com", to: "x@y.z", subject: "s", text: "t", headers: { "Auto-Submitted": "auto-replied" } });
	assert.equal(f.sent.length, 1);
});

test("compose is told which mailboxes it may send from", async (t) => {
	const f = await fixture(t);
	const sessions = await m.createSession(f.env, "reader");
	const response = await m.listMailboxes(new Request("https://mailflare.test/api/mailboxes", { headers: { Authorization: `Bearer ${sessions}` } }));
	const rows = (await response.json()).mailboxes.map((row) => [row.id, row.canSend]).sort();
	assert.deepEqual(rows, [["ceo", false], ["sales", false]]);
	const senderSession = await m.createSession(f.env, "sender");
	const own = (await (await m.listMailboxes(new Request("https://mailflare.test/api/mailboxes", { headers: { Authorization: `Bearer ${senderSession}` } }))).json()).mailboxes;
	assert.deepEqual(own.map((row) => [row.id, row.canSend]), [["sales", true]]);
});
