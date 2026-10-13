import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Backups must cover every table the migrations create, including push and Drive (0054-0057).
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(root, "node_modules", "mailflare-backup-coverage-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { assertBackupTablesCoverDatabase, exportDatabaseRecords, restoreDatabaseRecords } from "./src/lib/backups/export.ts";
		`,
		resolveDir: root,
		sourcefile: "backup-coverage-test-entry.ts",
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
const { SqliteDatabase, applyMigrations, assertBackupTablesCoverDatabase, exportDatabaseRecords, restoreDatabaseRecords } = await import(pathToFileURL(join(scratch, "entry.mjs")).href);

const NEW_TABLES = ["push_subscriptions", "drive_items", "drive_shares", "drive_upload_parts"];
const rows = (db, table) => db.prepare(`SELECT * FROM ${table}`).all().map((row) => ({ ...row })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const toBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

async function migrated(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	return database;
}

test("every table in a fully migrated database is covered by the backup", async (t) => {
	const database = await migrated(t);
	await assertBackupTablesCoverDatabase(database);
});

test("push subscriptions and Drive survive an export and restore", async (t) => {
	const database = await migrated(t);
	const db = database.db;
	db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('u1', 'a@ex.com', 'x', 'A', 1), ('u2', 'b@ex.com', 'x', 'B', 1);
		INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('s1', 'u1', 'h1', 9999999999, 1);
		INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth, created_at, updated_at) VALUES ('p1', 'u1', 's1', 'https://push.example/1', 'k', 'a', 1, 1);
		INSERT INTO drive_items (id, owner_id, parent_id, kind, name, r2_key, size, created_at, updated_at) VALUES
			('folder', 'u1', NULL, 'folder', 'Docs', NULL, 0, 1, 1),
			('file', 'u1', 'folder', 'file', 'a.pdf', 'drive/u1/file', 1234, 1, 1),
			('upload', 'u1', 'folder', 'file', 'big.zip', 'drive/u1/upload', 0, 1, 1);
		INSERT INTO drive_shares (id, item_id, user_id, role, created_at) VALUES ('sh1', 'file', 'u2', 'view', 1);
		INSERT INTO drive_upload_parts (item_id, part_number, etag) VALUES ('upload', 1, 'e1'), ('upload', 2, 'e2');
	`);
	const before = Object.fromEntries(NEW_TABLES.map((table) => [table, rows(db, table)]));
	const backup = await exportDatabaseRecords(database);
	const document = JSON.parse(new TextDecoder().decode(backup));
	for (const table of NEW_TABLES) assert.equal(document.tables[table].length, before[table].length, `${table} is exported`);

	// Lose the data, then restore it.
	db.exec("DELETE FROM drive_items; DELETE FROM users;");
	for (const table of NEW_TABLES) assert.equal(rows(db, table).length, 0);

	await restoreDatabaseRecords(database, toBuffer(backup));
	for (const table of NEW_TABLES) assert.deepEqual(rows(db, table), before[table], `${table} is restored`);
});
