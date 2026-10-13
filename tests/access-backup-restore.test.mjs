import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// picanteverde fork: restore is atomic and never deletes the append-only audit log.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(root, "node_modules", "mailflare-access-restore-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { exportDatabaseRecords, restoreDatabaseRecords } from "./src/lib/backups/export.ts";
		`,
		resolveDir: root,
		sourcefile: "access-restore-test-entry.ts",
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
const { SqliteDatabase, applyMigrations, exportDatabaseRecords, restoreDatabaseRecords } = await import(pathToFileURL(join(scratch, "entry.mjs")).href);

const ids = (db, table) => db.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map((row) => row.id);
const snapshot = (db) => Object.fromEntries(["users", "mailboxes", "mailbox_access", "messages", "sessions", "audit_logs"].map((table) => [table, ids(db, table)]));
const toBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

async function seeded(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	// Upstream gap: BACKUP_TABLES does not list these 0054-0057 tables, so export aborts on
	// any current database. Dropped here so the restore path can be exercised; tracked separately.
	database.db.exec("DROP TABLE drive_upload_parts; DROP TABLE drive_shares; DROP TABLE drive_items; DROP TABLE push_subscriptions;");
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES
			('admin', 'admin@ex.com', 'x', 'Admin', 'admin', 1, 1), ('bob', 'bob@ex.com', 'x', 'Bob', 'user', 0, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d', 'admin', 'ex.com', 'z', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('inbox', 'admin', 'd', 'hello', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, can_receive, can_send, created_at) VALUES ('g1', 'inbox', 'bob', 1, 0, 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, created_at) VALUES
			('m1', 'admin', 'inbox', 'inbound', 'x@y.z', 'hello@ex.com', 'one', 1);
		INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('s1', 'admin', 'h1', 9999999999, 1);
		INSERT INTO audit_logs (id, actor_user_id, target_user_id, mailbox_id, action, metadata, created_at) VALUES
			('l1', 'admin', 'bob', 'inbox', 'grant.set', '{"receive":true}', 1);
	`);
	return database;
}

test("restore replaces the data tables, keeps current audit rows and records the restore", async (t) => {
	const database = await seeded(t);
	const db = database.db;
	const backup = toBuffer(await exportDatabaseRecords(database));
	const backedUp = snapshot(db);

	// Changes made after the backup.
	db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('later', 'later@ex.com', 'x', 'Later', 2);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, created_at) VALUES ('m2', 'admin', 'inbox', 'inbound', 'a@b.c', 'hello@ex.com', 2);
		DELETE FROM mailbox_access WHERE id = 'g1';
		INSERT INTO audit_logs (id, actor_user_id, target_user_id, mailbox_id, action, created_at) VALUES ('l2', 'admin', 'bob', 'inbox', 'grant.revoke', 2);
	`);

	await restoreDatabaseRecords(database, backup, { actorUserId: "admin" });

	const after = snapshot(db);
	for (const table of ["users", "mailboxes", "mailbox_access", "messages", "sessions"]) assert.deepEqual(after[table], backedUp[table], `${table} matches the backup`);
	const audit = db.prepare("SELECT id, actor_user_id AS actor, action FROM audit_logs ORDER BY created_at, id").all().map((row) => ({ ...row }));
	assert.deepEqual(audit.slice(0, 2), [
		{ id: "l1", actor: "admin", action: "grant.set" },
		{ id: "l2", actor: "admin", action: "grant.revoke" },
	]);
	assert.equal(audit.length, 3);
	assert.equal(audit[2].action, "backup.restore");
	assert.equal(audit[2].actor, "admin");
});

test("a backup cannot overwrite an existing audit row", async (t) => {
	const database = await seeded(t);
	const db = database.db;
	const document = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(database)));
	document.tables.audit_logs = [{ ...document.tables.audit_logs[0], action: "forged", metadata: null }];
	await restoreDatabaseRecords(database, toBuffer(new TextEncoder().encode(JSON.stringify(document))), { actorUserId: "admin" });
	const row = db.prepare("SELECT action, metadata FROM audit_logs WHERE id = 'l1'").get();
	assert.deepEqual({ ...row }, { action: "grant.set", metadata: '{"receive":true}' });
});

test("a restore that fails part-way leaves the database untouched", async (t) => {
	const database = await seeded(t);
	const db = database.db;
	const document = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(database)));
	// The last table in restore order gets a row SQLite rejects, after every DELETE and most inserts have run.
	document.tables.ai_usage = [{ id: "bad", no_such_column: 1 }];
	const before = snapshot(db);
	const appSettings = db.prepare("SELECT count(*) AS n FROM app_settings").get().n;
	await assert.rejects(restoreDatabaseRecords(database, toBuffer(new TextEncoder().encode(JSON.stringify(document))), { actorUserId: "admin" }));
	assert.deepEqual(snapshot(db), before);
	assert.equal(db.prepare("SELECT count(*) AS n FROM app_settings").get().n, appSettings);
	assert.equal(db.prepare("SELECT count(*) AS n FROM audit_logs WHERE action = 'backup.restore'").get().n, 0);
});
