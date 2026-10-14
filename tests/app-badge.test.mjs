import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// picanteverde fork: the app-icon badge count follows receive grants, and the push adds only that number.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(root, "node_modules", "mailflare-app-badge-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createDb } from "./src/db/index.ts";
			export { countInboxUnread } from "./src/lib/push/unread.ts";
		`,
		resolveDir: root,
		sourcefile: "app-badge-test-entry.ts",
	},
	outfile: join(scratch, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, createDb, countInboxUnread } = await import(pathToFileURL(join(scratch, "entry.mjs")).href);

let database;
let db;
const NOW = new Date(10_000_000);
before(async () => {
	database = new SqliteDatabase(":memory:");
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, disabled, created_at) VALUES
			('pv', 'pv@ex.com', 'x', 'Two mailboxes', 'admin', 0, 1),
			('ana', 'ana@ex.com', 'x', 'Only info', 'user', 0, 1),
			('nob', 'nob@ex.com', 'x', 'No grants', 'admin', 0, 1),
			('off', 'off@ex.com', 'x', 'Disabled', 'user', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d', 'pv', 'ex.com', 'z', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, disabled, created_at) VALUES
			('me', 'pv', 'd', 'me', 'personal', 0, 1),
			('info', 'pv', 'd', 'info', 'shared', 0, 1),
			('old', 'pv', 'd', 'old', 'shared', 1, 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, can_receive, can_send, created_at) VALUES
			('g1', 'me', 'pv', 1, 1, 1),
			('g2', 'info', 'pv', 1, 0, 1),
			('g3', 'old', 'pv', 1, 1, 1),
			('g4', 'info', 'ana', 1, 1, 1),
			('g5', 'info', 'off', 1, 1, 1);
		INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('f', 'pv', 'me', 'Receipts', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, read, folder_id, snoozed_until, created_at) VALUES
			('a', 'pv', 'me', 'inbound', 'x@y.z', 'me@ex.com', 's', 'received', 0, NULL, NULL, 1),
			('b', 'pv', 'me', 'inbound', 'x@y.z', 'me@ex.com', 's', 'received', 1, NULL, NULL, 1),
			('c', 'pv', 'info', 'inbound', 'x@y.z', 'info@ex.com', 's', 'received', 0, NULL, NULL, 1),
			('d1', 'pv', 'info', 'inbound', 'x@y.z', 'info@ex.com', 's', 'received', 0, NULL, NULL, 1),
			('spam', 'pv', 'me', 'inbound', 'x@y.z', 'me@ex.com', 's', 'spam', 0, NULL, NULL, 1),
			('trash', 'pv', 'me', 'inbound', 'x@y.z', 'me@ex.com', 's', 'trash', 0, NULL, NULL, 1),
			('arch', 'pv', 'me', 'inbound', 'x@y.z', 'me@ex.com', 's', 'archived', 0, NULL, NULL, 1),
			('filed', 'pv', 'me', 'inbound', 'x@y.z', 'me@ex.com', 's', 'received', 0, 'f', NULL, 1),
			('snz', 'pv', 'me', 'inbound', 'x@y.z', 'me@ex.com', 's', 'received', 0, NULL, 20000, 1),
			('woke', 'pv', 'me', 'inbound', 'x@y.z', 'me@ex.com', 's', 'received', 0, NULL, 5000, 1),
			('draft', 'pv', 'me', 'outbound', 'me@ex.com', 'x@y.z', 's', 'draft', 0, NULL, NULL, 1),
			('sent', 'pv', 'me', 'outbound', 'me@ex.com', 'x@y.z', 's', 'sent', 0, NULL, NULL, 1),
			('dis', 'pv', 'old', 'inbound', 'x@y.z', 'old@ex.com', 's', 'received', 0, NULL, NULL, 1),
			('orphan', 'pv', NULL, 'inbound', 'x@y.z', 'nobody@ex.com', 's', 'received', 0, NULL, NULL, 1);
	`);
	db = createDb(database);
});

const user = (id) => ({ id, email: `${id}@ex.com` });

test("sums unread inbox mail over every mailbox the account may receive from", async () => {
	// me: a + woke (snooze over); info: c + d1. Not: read, spam, trash, archived, filed, still snoozed, drafts, sent, disabled mailbox, no mailbox.
	assert.equal(await countInboxUnread(db, user("pv"), NOW), 4);
	assert.equal(await countInboxUnread(db, user("ana"), NOW), 2);
});

test("no grants, or a disabled account, count nothing", async () => {
	assert.equal(await countInboxUnread(db, user("nob"), NOW), 0, "an admin without grants sees no badge");
	assert.equal(await countInboxUnread(db, user("off"), NOW), 0);
});

test("a revoked grant stops counting at once", async () => {
	database.db.exec("UPDATE mailbox_access SET can_receive = 0 WHERE id = 'g2'");
	assert.equal(await countInboxUnread(db, user("pv"), NOW), 2);
	database.db.exec("UPDATE mailbox_access SET can_receive = 1 WHERE id = 'g2'");
});

test("the push payload adds only the number; the service worker sets or clears the badge", () => {
	const server = readFileSync(join(root, "src/lib/push/server.ts"), "utf8");
	const payload = server.slice(server.indexOf("const notificationPayload"), server.indexOf("await Promise.allSettled"));
	assert.match(payload, /\bunread,\n/);
	assert.doesNotMatch(payload, /mailboxId|mailboxName|unreadBy/);
	assert.match(server, /eq\(users\.disabled, false\)/, "disabled accounts get no pushes");
	const sw = readFileSync(join(root, "public/sw.js"), "utf8");
	assert.match(sw, /setAppBadge/);
	assert.match(sw, /clearAppBadge/);
	assert.ok(sw.indexOf("setUnreadBadge(payload.unread)") < sw.indexOf("visibilityState"), "the badge updates even while a tab is open");
});
