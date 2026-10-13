import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// picanteverde fork: migration 0061 (mailbox grants) on a database shaped like today's.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = join(root, "drizzle/migrations");
const GRANTS = "0061_mailbox_grants.sql";
const scratch = mkdtempSync(join(root, "node_modules", "mailflare-access-migration-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
		`,
		resolveDir: root,
		sourcefile: "access-migration-test-entry.ts",
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
const { SqliteDatabase, applyMigrations } = await import(pathToFileURL(join(scratch, "entry.mjs")).href);

// A copy of the migrations directory that stops at 0060.
const before0061 = join(scratch, "migrations");
cpSync(migrationsDirectory, before0061, { recursive: true });
rmSync(join(before0061, GRANTS));

const COUNTED = ["users", "domains", "mailboxes", "messages", "audit_logs", "sessions"];
const counts = (db) => Object.fromEntries(COUNTED.map((table) => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
const grant = (db, mailbox, user) =>
	db.prepare("SELECT can_receive AS r, can_send AS s, permission FROM mailbox_access WHERE mailbox_id = ? AND user_id = ?").get(mailbox, user);

/** Today's production shape: one primary admin owning everything, plus legacy access rows of every level. */
function seed(db) {
	db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES
			('admin', 'admin@ex.com', 'x', 'Admin', 'admin', 1, 1),
			('ro', 'ro@ex.com', 'x', 'Read only', 'user', 0, 1),
			('sa', 'sa@ex.com', 'x', 'Send as', 'user', 0, 1),
			('sob', 'sob@ex.com', 'x', 'On behalf', 'user', 0, 1),
			('fa', 'fa@ex.com', 'x', 'Full', 'user', 0, 1),
			('nobody', 'nobody@ex.com', 'x', 'No grants', 'user', 0, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d', 'admin', 'ex.com', 'z', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES
			('inbox', 'admin', 'd', 'hello', 'personal', 1),
			('team', 'admin', 'd', 'team', 'shared', 1),
			('own', 'fa', 'd', 'fa', 'personal', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_by_user_id, created_at) VALUES
			('a1', 'team', 'ro', 'read_only', 'admin', 5),
			('a2', 'team', 'sa', 'send_as', 'admin', 5),
			('a3', 'team', 'sob', 'send_on_behalf', 'admin', 5),
			('a4', 'team', 'fa', 'full_access', 'admin', 5),
			('a5', 'own', 'fa', 'read_only', 'admin', 5);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, created_at) VALUES
			('m1', 'admin', 'inbox', 'inbound', 'x@y.z', 'hello@ex.com', 'one', 1),
			('m2', 'admin', 'inbox', 'outbound', 'hello@ex.com', 'x@y.z', 'two', 2),
			('m3', 'admin', 'team', 'inbound', 'x@y.z', 'team@ex.com', 'three', 3);
		INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('s1', 'admin', 'h1', 9999999999, 1);
		INSERT INTO audit_logs (id, actor_user_id, target_user_id, mailbox_id, message_id, action, metadata, created_at) VALUES
			('l1', 'admin', 'ro', 'team', 'm3', 'mailbox.share', '{}', 1);
	`);
}

/** Runs 0000→0060 through the runtime runner, seeds, then applies 0061 via `apply`. */
async function migrate(t, apply) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, before0061);
	const db = database.db;
	seed(db);
	const beforeCounts = counts(db);
	await apply(database);
	return { db, beforeCounts };
}

function assertGrants(db, beforeCounts) {
	assert.deepEqual(counts(db), beforeCounts, "no user, mailbox, message, session or audit row is lost");
	// Legacy levels map onto receive/send.
	assert.deepEqual({ ...grant(db, "team", "ro") }, { r: 1, s: 0, permission: "read_only" });
	assert.deepEqual({ ...grant(db, "team", "sa") }, { r: 1, s: 1, permission: "send_as" });
	assert.deepEqual({ ...grant(db, "team", "sob") }, { r: 1, s: 1, permission: "send_on_behalf" });
	assert.deepEqual({ ...grant(db, "team", "fa") }, { r: 1, s: 1, permission: "full_access" });
	// Owners keep everything they own: new rows for the admin, an upgraded row for fa.
	assert.deepEqual({ r: grant(db, "inbox", "admin").r, s: grant(db, "inbox", "admin").s }, { r: 1, s: 1 });
	assert.deepEqual({ r: grant(db, "team", "admin").r, s: grant(db, "team", "admin").s }, { r: 1, s: 1 });
	assert.deepEqual({ r: grant(db, "own", "fa").r, s: grant(db, "own", "fa").s }, { r: 1, s: 1 });
	// No grant appears out of nowhere.
	assert.equal(db.prepare("SELECT count(*) AS n FROM mailbox_access WHERE user_id = 'nobody'").get().n, 0);
	assert.equal(db.prepare("SELECT count(*) AS n FROM mailbox_access").get().n, 7);
	assert.equal(db.prepare("SELECT count(*) AS n FROM mailbox_access WHERE can_receive = 0 AND can_send = 1").get().n, 0);
	// Provenance carried over from the legacy columns.
	const legacy = db.prepare("SELECT granted_by_user_id AS by, granted_at AS at FROM mailbox_access WHERE id = 'a1'").get();
	assert.deepEqual({ ...legacy }, { by: "admin", at: 5 });
	const ids = db.prepare("SELECT id FROM mailbox_access WHERE id NOT LIKE 'a_'").all().map((row) => row.id);
	assert.equal(ids.length, 2);
	for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	// Indexes for the hot check and session revocation.
	const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name);
	assert.ok(indexes.includes("mailbox_access_user_receive_idx"));
	assert.ok(indexes.includes("sessions_user_idx"));
}

function assertAuditAppendOnly(db) {
	db.prepare("INSERT INTO audit_logs (id, actor_user_id, action, created_at) VALUES ('l2', 'admin', 'grant.set', 2)").run();
	assert.throws(() => db.prepare("DELETE FROM audit_logs WHERE id = 'l1'").run(), /append-only/);
	assert.throws(() => db.prepare("UPDATE audit_logs SET action = 'x' WHERE id = 'l1'").run(), /append-only/);
	assert.throws(() => db.prepare("UPDATE audit_logs SET metadata = NULL WHERE id = 'l1'").run(), /append-only/);
	assert.throws(() => db.prepare("UPDATE audit_logs SET actor_user_id = 'ro' WHERE id = 'l1'").run(), /append-only/);
	// Removing a referenced message still works: its FK action only nulls the reference.
	db.exec("PRAGMA foreign_keys = ON");
	db.prepare("DELETE FROM messages WHERE id = 'm3'").run();
	const row = db.prepare("SELECT message_id, action FROM audit_logs WHERE id = 'l1'").get();
	assert.deepEqual({ ...row }, { message_id: null, action: "mailbox.share" });
}

test("0061 via the runtime runner keeps every row and backfills grants", async (t) => {
	const { db, beforeCounts } = await migrate(t, async (database) => {
		cpSync(join(migrationsDirectory, GRANTS), join(before0061, GRANTS));
		t.after(() => rmSync(join(before0061, GRANTS)));
		assert.deepEqual(await applyMigrations(database, before0061), [GRANTS]);
	});
	assertGrants(db, beforeCounts);
	assertAuditAppendOnly(db);
});

test("0061 via the in-app bundle statements gives the same result", async (t) => {
	const { db, beforeCounts } = await migrate(t, async (database) => {
		const { migrations } = JSON.parse(readFileSync(join(root, "src/lib/migrations/bundle.json"), "utf8"));
		const migration = migrations.find((candidate) => candidate.name === GRANTS);
		assert.ok(migration, "run `npm run db:bundle` first");
		database.db.exec("BEGIN");
		for (const statement of migration.statements) database.db.exec(statement);
		database.db.exec("COMMIT");
	});
	assertGrants(db, beforeCounts);
	assertAuditAppendOnly(db);
});

test("0061 is the last migration and is listed in the journal", () => {
	const files = readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort();
	assert.equal(files.at(-1), GRANTS);
	const journal = JSON.parse(readFileSync(join(migrationsDirectory, "meta/_journal.json"), "utf8"));
	assert.equal(journal.entries.at(-1).tag, "0061_mailbox_grants");
});
