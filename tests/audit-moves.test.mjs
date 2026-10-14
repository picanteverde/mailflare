import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// picanteverde fork: every bulk move leaves one audit row, with its mailbox (QA on #17/#18).
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-audit-moves-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { POST as bulk } from "./src/app/api/messages/bulk/route.ts";
		`,
		resolveDir: root,
		sourcefile: "audit-moves-entry.ts",
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
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, totp_enabled, created_at) VALUES ('bob', 'bob@ex.com', 'x', 'Bob', 'user', 0, 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d', 'bob', 'ex.com', 'manual', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('team', 'bob', 'd', 'team', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, can_receive, can_send, created_at) VALUES ('g', 'team', 'bob', 1, 1, 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, snoozed_until, created_at) VALUES
			('m1', 'bob', 'team', 'inbound', 'x@y.z', 'team@ex.com', 'one', 'received', NULL, 1),
			('m2', 'bob', 'team', 'inbound', 'x@y.z', 'team@ex.com', 'two', 'received', 999999999999, 2);
	`);
	const env = { DB: database, MAILFLARE_RUNTIME: "node" };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const session = await m.createSession(env, "bob");
	const bulk = (body) => m.bulk(new Request("https://mailflare.test/api/messages/bulk", {
		method: "POST",
		body: JSON.stringify(body),
		headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json", Origin: "https://mailflare.test" },
	}));
	const audit = () => database.db.prepare("SELECT action, mailbox_id AS mailboxId, message_id AS messageId, metadata FROM audit_logs WHERE message_id IS NOT NULL ORDER BY rowid").all();
	const row = (id) => database.db.prepare("SELECT status, snoozed_until AS snoozedUntil FROM messages WHERE id = ?").get(id);
	return { bulk, audit, row };
}

test("archive, unarchive and inbox moves are audited as email.move with their mailbox", async (t) => {
	const f = await fixture(t);
	assert.equal((await f.bulk({ messageIds: ["m1"], action: "archive" })).status, 200);
	assert.equal((await f.bulk({ messageIds: ["m1"], action: "unarchive" })).status, 200);
	assert.equal((await f.bulk({ messageIds: ["m1"], action: "trash" })).status, 200);
	assert.equal((await f.bulk({ messageIds: ["m1"], action: "inbox" })).status, 200);
	const rows = f.audit();
	assert.deepEqual(rows.map((r) => [r.action, JSON.parse(r.metadata).bulkAction]), [["email.move", "archive"], ["email.move", "unarchive"], ["email.move", "trash"], ["email.move", "inbox"]]);
	assert.ok(rows.every((r) => r.mailboxId === "team" && r.messageId === "m1"), "mailbox and message on every row");
});

test("unarchive restores a snoozed message without clearing its snooze; only archived mail", async (t) => {
	const f = await fixture(t);
	await f.bulk({ messageIds: ["m2"], action: "archive" });
	assert.equal(f.row("m2").status, "archived");
	await f.bulk({ messageIds: ["m2"], action: "unarchive" });
	assert.equal(f.row("m2").status, "received");
	assert.ok(f.row("m2").snoozedUntil, "snooze kept, so it is back in Snoozed");
	assert.equal((await f.bulk({ messageIds: ["m1"], action: "unarchive" })).status, 404, "not archived: nothing to undo");
});

test("marking the same message as spam again is audited again (it moves it again)", async (t) => {
	const f = await fixture(t);
	assert.equal((await f.bulk({ messageIds: ["m1"], action: "spam" })).status, 200);
	assert.equal((await f.bulk({ messageIds: ["m1"], action: "trash" })).status, 200);
	assert.equal((await f.bulk({ messageIds: ["m1"], action: "spam" })).status, 200);
	assert.equal(f.row("m1").status, "spam");
	const feedback = f.audit().filter((r) => r.action === "email.spam_feedback");
	assert.equal(feedback.length, 2);
	assert.ok(feedback.every((r) => r.mailboxId === "team"));
	assert.equal(JSON.parse(feedback[1].metadata).repeated, true);
});
