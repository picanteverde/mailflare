import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// picanteverde fork: can() and everything that must follow the same rule.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(root, "node_modules", "mailflare-access-can-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createDb } from "./src/db/index.ts";
			export { can, getMailboxAccessLevel, listAccessibleMailboxIds, loadMailboxGrants } from "./src/lib/mailboxes/access.ts";
			export { getUserMailRevision } from "./src/lib/realtime/revision.ts";
			export { getMailboxNotificationUserIds } from "./src/lib/realtime/utils.ts";
		`,
		resolveDir: root,
		sourcefile: "access-can-test-entry.ts",
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
const mod = await import(pathToFileURL(join(scratch, "entry.mjs")).href);
const { SqliteDatabase, applyMigrations, createDb, can, getMailboxAccessLevel, listAccessibleMailboxIds, loadMailboxGrants, getUserMailRevision, getMailboxNotificationUserIds } = mod;

let database;
let db;
before(async () => {
	database = new SqliteDatabase(":memory:");
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, disabled, created_at) VALUES
			('admin', 'admin@ex.com', 'x', 'Admin', 'admin', 0, 1),
			('admin2', 'admin2@ex.com', 'x', 'Admin without grants', 'admin', 0, 1),
			('zed', 'zed@ex.com', 'x', 'Disabled admin', 'admin', 1, 1),
			('alice', 'alice@ex.com', 'x', 'Receive only', 'user', 0, 1),
			('bob', 'bob@ex.com', 'x', 'Receive and send', 'user', 0, 1),
			('carol', 'carol@ex.com', 'x', 'Disabled account', 'user', 1, 1),
			('dave', 'dave@ex.com', 'x', 'Owner without grant', 'user', 0, 1),
			('eve', 'eve@ex.com', 'x', 'Legacy full_access, no flags', 'user', 0, 1),
			('sam', 'sam@ex.com', 'x', 'Send flag without receive', 'user', 0, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d', 'admin', 'ex.com', 'z', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, disabled, created_at) VALUES
			('m1', 'admin', 'd', 'hello', 'personal', 0, 1),
			('m2', 'admin', 'd', 'old', 'shared', 1, 1),
			('m3', 'dave', 'd', 'dave', 'personal', 0, 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, can_receive, can_send, created_at) VALUES
			('g1', 'm1', 'admin', 'full_access', 1, 1, 1),
			('g2', 'm1', 'alice', 'full_access', 1, 0, 1),
			('g3', 'm1', 'bob', 'read_only', 1, 1, 1),
			('g4', 'm2', 'bob', 'full_access', 1, 1, 1),
			('g5', 'm1', 'carol', 'full_access', 1, 1, 1),
			('g6', 'm1', 'eve', 'full_access', 0, 0, 1),
			('g7', 'm1', 'sam', 'send_as', 0, 1, 1),
			('g8', 'm1', 'zed', 'full_access', 1, 1, 1);
	`);
	db = createDb(database);
});
after(() => database?.db.close());

const matrix = [
	// [user, mailbox, receive, send, admin]
	["admin", "m1", true, true, true],
	["admin2", "m1", false, false, true],
	["admin2", "m2", false, false, true],
	["zed", "m1", false, false, false],
	["alice", "m1", true, false, false],
	["bob", "m1", true, true, false],
	["bob", "m2", false, false, false],
	["carol", "m1", false, false, false],
	["dave", "m3", false, false, false],
	["eve", "m1", false, false, false],
	["sam", "m1", false, false, false],
	["alice", "missing", false, false, false],
	["nobody", "m1", false, false, false],
];

test("can() follows the grant matrix", async () => {
	for (const [user, mailbox, receive, send, admin] of matrix) {
		assert.equal(await can(db, { id: user }, mailbox, "receive"), receive, `${user} receive ${mailbox}`);
		assert.equal(await can(db, { id: user }, mailbox, "send"), send, `${user} send ${mailbox}`);
		assert.equal(await can(db, { id: user }, mailbox, "admin"), admin, `${user} admin ${mailbox}`);
	}
});

test("the caller's claimed role is ignored; role and disabled come from the database", async () => {
	assert.equal(await can(db, { id: "alice", role: "admin" }, "m1", "admin"), false);
	assert.equal(await can(db, { id: "zed", role: "admin" }, "m1", "admin"), false);
});

test("getMailboxAccessLevel is null without a receive grant, so routes answer 404", async () => {
	assert.equal(await getMailboxAccessLevel(db, { id: "admin2" }, "m1"), null);
	assert.equal(await getMailboxAccessLevel(db, { id: "dave" }, "m3"), null);
	assert.equal(await getMailboxAccessLevel(db, { id: "eve" }, "m1"), null);
	const alice = await getMailboxAccessLevel(db, { id: "alice" }, "m1");
	assert.deepEqual(
		{ canRead: alice.canRead, canOrganize: alice.canOrganize, canSend: alice.canSend, canSendOnBehalf: alice.canSendOnBehalf, canManage: alice.canManage, isOwner: alice.isOwner, permission: alice.permission },
		{ canRead: true, canOrganize: true, canSend: false, canSendOnBehalf: false, canManage: false, isOwner: false, permission: "read_only" },
	);
	const bob = await getMailboxAccessLevel(db, { id: "bob" }, "m1");
	assert.deepEqual(
		{ canSend: bob.canSend, canSendAs: bob.canSendAs, canSendOnBehalf: bob.canSendOnBehalf, canManage: bob.canManage, permission: bob.permission },
		{ canSend: true, canSendAs: true, canSendOnBehalf: true, canManage: false, permission: "send_as" },
	);
	const admin = await getMailboxAccessLevel(db, { id: "admin" }, "m1");
	assert.equal(admin.canSend, true);
	assert.equal(admin.canManage, true);
	assert.equal(admin.isOwner, false);
});

test("lists come from grants only", async () => {
	const ids = async (user, action) => (await listAccessibleMailboxIds(db, { id: user, email: `${user}@ex.com` }, action)).sort();
	assert.deepEqual(await ids("bob"), ["m1"]);
	assert.deepEqual(await ids("alice"), ["m1"]);
	assert.deepEqual(await ids("alice", "send"), []);
	assert.deepEqual(await ids("dave"), []);
	assert.deepEqual(await ids("admin2"), []);
	assert.deepEqual(await ids("carol"), []);
	assert.deepEqual(await ids("eve"), []);
	const grants = await loadMailboxGrants(db, { id: "alice", email: "alice@ex.com" });
	assert.equal(grants.can("m1", "receive"), true);
	assert.equal(grants.can("m1", "send"), false);
	assert.equal(grants.can("m3", "receive"), false);
});

test("no cache: a grant change applies on the next call", async () => {
	assert.equal(await can(db, { id: "dave" }, "m1", "receive"), false);
	database.db.exec("INSERT INTO mailbox_access (id, mailbox_id, user_id, can_receive, can_send, created_at) VALUES ('tmp', 'm1', 'dave', 1, 0, 1)");
	assert.equal(await can(db, { id: "dave" }, "m1", "receive"), true);
	database.db.exec("UPDATE users SET disabled = 1 WHERE id = 'dave'");
	assert.equal(await can(db, { id: "dave" }, "m1", "receive"), false);
	database.db.exec("UPDATE users SET disabled = 0 WHERE id = 'dave'; DELETE FROM mailbox_access WHERE id = 'tmp'");
	assert.equal(await can(db, { id: "dave" }, "m1", "receive"), false);
});

test("realtime revisions and notifications use the same rule", async () => {
	const env = { DB: database };
	const bob = JSON.parse(await getUserMailRevision(env, "bob"));
	assert.deepEqual(bob.map((row) => row[0]), ["m1"]);
	assert.equal(bob[0][2], "receive+send");
	assert.deepEqual(JSON.parse(await getUserMailRevision(env, "dave")), []);
	assert.deepEqual(JSON.parse(await getUserMailRevision(env, "carol")), []);
	assert.deepEqual((await getMailboxNotificationUserIds(env, "m1")).sort(), ["admin", "alice", "bob"]);
	assert.deepEqual(await getMailboxNotificationUserIds(env, "m3"), []);
	assert.deepEqual(await getMailboxNotificationUserIds(env, "m2"), []);
});

test("the access module never reads the legacy permission column or the license", () => {
	const source = readFileSync(join(root, "src/lib/mailboxes/access.ts"), "utf8");
	assert.doesNotMatch(source, /mailboxAccess\.permission/);
	assert.doesNotMatch(source, /licenseSettings|isTeamMailboxSharingEnabled|eq\(mailboxes\.type|eq\(mailboxes\.userId/);
	for (const file of ["src/lib/realtime/revision.ts", "src/lib/realtime/utils.ts"]) {
		const text = readFileSync(join(root, file), "utf8");
		assert.doesNotMatch(text, /a\.permission|mailboxAccess\.permission|isTeamMailboxSharingEnabled|m\.type|m\.user_id/, file);
	}
});
