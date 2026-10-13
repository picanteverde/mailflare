import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// picanteverde fork, Phase 7a: the admin grants API and admin-only mailbox creation.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-access-grants-"));
after(() => rmSync(directory, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { createDb } from "./src/db/index.ts";
			export { can } from "./src/lib/mailboxes/access.ts";
			export { GET as accountGrants, PUT as putAccountGrants } from "./src/app/api/accounts/[id]/mailbox-access/route.ts";
			export { GET as mailboxGrants, PUT as putMailboxGrants } from "./src/app/api/mailboxes/[id]/access/route.ts";
			export { POST as createMailbox } from "./src/app/api/mailboxes/route.ts";
			export { GET as listMailboxes } from "./src/app/api/mailboxes/route.ts";
			export { GET as getMailbox } from "./src/app/api/mailboxes/[id]/route.ts";
			export { GET as auditLogs } from "./src/app/api/audit-logs/route.ts";
		`,
		resolveDir: root,
		sourcefile: "access-grants-test-entry.ts",
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

async function fixture(t, extraMailboxes = 0) {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await m.applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, totp_enabled, created_at) VALUES
			('admin', 'admin@ex.com', 'x', 'Admin', 'admin', 1, 1, 1),
			('alice', 'alice@ex.com', 'x', 'Alice', 'user', 0, 1, 1),
			('bob', 'bob@ex.com', 'x', 'Bob', 'user', 0, 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, receiving_provider, created_at) VALUES ('d', 'admin', 'ex.com', 'manual', 'active', 'none', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('sales', 'admin', 'd', 'sales', 1), ('support', 'admin', 'd', 'support', 1), ('ceo', 'admin', 'd', 'ceo', 1);
	`);
	const insertMailbox = database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES (?, 'admin', 'd', ?, 1)");
	for (let index = 0; index < extraMailboxes; index += 1) insertMailbox.run(`bulk${index}`, `bulk${index}`);
	const env = { DB: database, MAILFLARE_RUNTIME: "node" };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	t.mock.method(globalThis, "fetch", async () => { throw new Error("tests must never contact a real service"); });
	const sessions = { admin: await m.createSession(env, "admin"), alice: await m.createSession(env, "alice") };
	const req = (user, path, method = "GET", body) => new Request(`${ORIGIN}${path}`, {
		method,
		headers: { Authorization: `Bearer ${sessions[user]}`, "Content-Type": "application/json", Origin: ORIGIN },
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	const params = (id) => ({ params: Promise.resolve({ id }) });
	const audit = () => database.db.prepare("SELECT action, target_user_id AS target, mailbox_id AS mailbox, metadata FROM audit_logs WHERE action LIKE 'grant.%' OR action = 'mailbox.create' ORDER BY rowid").all().map((row) => ({ ...row, metadata: JSON.parse(row.metadata) }));
	return { database, env, db: m.createDb(database), req, params, audit };
}

test("from an account's page: set many mailboxes at once, audited per pair with the previous value", async (t) => {
	const f = await fixture(t);
	const put = (user, grants) => m.putAccountGrants(f.req(user, "/api/accounts/alice/mailbox-access", "PUT", { grants }), f.params("alice"));
	const response = await put("admin", [
		{ mailboxId: "sales", receive: true, send: true },
		{ mailboxId: "support", receive: true, send: false },
		{ mailboxId: "ceo", receive: false, send: false },
	]);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { changed: 2 }, "ceo was already none: no-op, no row");
	assert.equal(await m.can(f.db, { id: "alice" }, "sales", "send"), true, "applies on the next call");
	assert.equal(await m.can(f.db, { id: "alice" }, "support", "send"), false);
	assert.deepEqual(f.audit(), [
		{ action: "grant.set", target: "alice", mailbox: "sales", metadata: { receive: true, send: true, previous: { receive: false, send: false }, self: false } },
		{ action: "grant.set", target: "alice", mailbox: "support", metadata: { receive: true, send: false, previous: { receive: false, send: false }, self: false } },
	]);
	// Downgrade and revoke.
	assert.deepEqual(await (await put("admin", [{ mailboxId: "sales", receive: true, send: false }, { mailboxId: "support", receive: false, send: false }])).json(), { changed: 2 });
	const rows = f.audit().slice(2);
	assert.deepEqual(rows[0].metadata.previous, { receive: true, send: true });
	assert.equal(rows[1].action, "grant.revoke");
	assert.deepEqual(rows[1].metadata, { previous: { receive: true, send: false }, self: false });
	assert.equal(await m.can(f.db, { id: "alice" }, "support", "receive"), false);
	const listed = await (await m.accountGrants(f.req("admin", "/api/accounts/alice/mailbox-access"), f.params("alice"))).json();
	assert.deepEqual(listed.mailboxes.map((row) => [row.address, row.receive, row.send]), [["ceo@ex.com", false, false], ["sales@ex.com", true, false], ["support@ex.com", false, false]]);
});

test("the server enforces the rules: admin only, send needs receive, all-or-nothing", async (t) => {
	const f = await fixture(t);
	const put = (user, grants, id = "alice") => m.putAccountGrants(f.req(user, `/api/accounts/${id}/mailbox-access`, "PUT", { grants }), f.params(id));
	assert.equal((await put("alice", [{ mailboxId: "sales", receive: true, send: true }])).status, 403, "a plain account can't grant itself");
	assert.equal((await m.accountGrants(f.req("alice", "/api/accounts/alice/mailbox-access"), f.params("alice"))).status, 403);
	assert.equal((await put("admin", [{ mailboxId: "sales", receive: false, send: true }])).status, 400);
	const missing = await put("admin", [{ mailboxId: "sales", receive: true, send: false }, { mailboxId: "nope", receive: true, send: false }]);
	assert.equal(missing.status, 404);
	assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM mailbox_access").get().n, 0, "nothing written when one pair is invalid");
	assert.equal(f.audit().length, 0);
	assert.equal((await put("admin", [{ mailboxId: "sales", receive: true, send: false }, { mailboxId: "sales", receive: true, send: true }])).status, 400, "duplicate pair");
	// A no-longer-admin session loses the API immediately (role re-read from the database).
	f.database.db.exec("UPDATE users SET role = 'user', is_primary_admin = 0 WHERE id = 'admin'");
	assert.equal((await put("admin", [{ mailboxId: "sales", receive: true, send: false }])).status, 403);
});

test("from a mailbox's page: many accounts, and an admin granting themselves is flagged", async (t) => {
	const f = await fixture(t);
	const response = await m.putMailboxGrants(f.req("admin", "/api/mailboxes/ceo/access", "PUT", { grants: [
		{ userId: "admin", receive: true, send: false },
		{ userId: "bob", receive: true, send: true },
	] }), f.params("ceo"));
	assert.deepEqual(await response.json(), { changed: 2 });
	const [self, bob] = f.audit();
	assert.equal(self.target, "admin");
	assert.equal(self.metadata.self, true);
	assert.equal(bob.metadata.self, false);
	const listed = await (await m.mailboxGrants(f.req("admin", "/api/mailboxes/ceo/access"), f.params("ceo"))).json();
	assert.deepEqual(listed.accounts.map((row) => [row.email, row.receive, row.send]), [["admin@ex.com", true, false], ["alice@ex.com", false, false], ["bob@ex.com", true, true]]);
});

test("bulk: one account to 150 mailboxes in one atomic request, one audit row each", async (t) => {
	const f = await fixture(t, 150);
	const grants = Array.from({ length: 150 }, (_value, index) => ({ mailboxId: `bulk${index}`, receive: true, send: index % 2 === 0 }));
	const response = await m.putAccountGrants(f.req("admin", "/api/accounts/bob/mailbox-access", "PUT", { grants }), f.params("bob"));
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { changed: 150 });
	assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM mailbox_access WHERE user_id = 'bob'").get().n, 150);
	assert.equal(f.audit().length, 150);
	assert.equal((await m.putAccountGrants(f.req("admin", "/api/accounts/bob/mailbox-access", "PUT", { grants: Array.from({ length: 201 }, (_v, i) => ({ mailboxId: `bulk${i}`, receive: true, send: false })) }), f.params("bob"))).status, 400, "over the per-request cap");
});

test("creating a mailbox is admin-only, grants nobody implicitly, and can grant in the same request", async (t) => {
	const f = await fixture(t);
	const create = (user, body) => m.createMailbox(f.req(user, "/api/mailboxes", "POST", body));
	assert.equal((await create("alice", { domainId: "d", localPart: "mine" })).status, 403);
	const response = await create("admin", { domainId: "d", localPart: "Billing", displayName: "Billing", ownerUserId: "alice", type: "personal", grants: [{ userId: "alice", receive: true, send: false }] });
	assert.equal(response.status, 200);
	const { id, address } = await response.json();
	assert.equal(address, "billing@ex.com");
	const row = f.database.db.prepare("SELECT user_id AS owner FROM mailboxes WHERE id = ?").get(id);
	assert.equal(row.owner, "admin", "owner is the domain owner; the ownerUserId field is ignored");
	assert.deepEqual(f.database.db.prepare("SELECT user_id AS user, can_receive AS r, can_send AS s FROM mailbox_access WHERE mailbox_id = ?").all(id).map((r) => ({ ...r })), [{ user: "alice", r: 1, s: 0 }], "no creator grant");
	assert.deepEqual(f.audit().map((entry) => entry.action), ["mailbox.create", "grant.set"]);
	assert.equal((await create("admin", { domainId: "d", localPart: "billing" })).status, 409);
	assert.equal((await create("admin", { domainId: "d", localPart: "x", grants: [{ userId: "alice", receive: false, send: true }] })).status, 400);
	assert.equal((await create("admin", { domainId: "d", localPart: "ghost", grants: [{ userId: "nobody", receive: true, send: false }] })).status, 404);
	assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM mailboxes WHERE local_part = 'ghost'").get().n, 0, "a bad grant leaves no mailbox behind");
});

test("admin screens: every mailbox listed and its settings readable without a grant; history is primary-only", async (t) => {
	const f = await fixture(t);
	const all = await m.listMailboxes(f.req("admin", "/api/mailboxes?all=1"));
	assert.deepEqual((await all.json()).mailboxes.map((row) => row.id).sort(), ["ceo", "sales", "support"]);
	assert.equal((await m.listMailboxes(f.req("alice", "/api/mailboxes?all=1"))).status, 403);
	assert.deepEqual((await (await m.listMailboxes(f.req("admin", "/api/mailboxes"))).json()).mailboxes, [], "the mail view still lists grants only");
	assert.equal((await m.getMailbox(f.req("admin", "/api/mailboxes/sales"), f.params("sales"))).status, 200);
	assert.equal((await m.getMailbox(f.req("alice", "/api/mailboxes/sales"), f.params("sales"))).status, 404);
	await m.putAccountGrants(f.req("admin", "/api/accounts/alice/mailbox-access", "PUT", { grants: [{ mailboxId: "sales", receive: true, send: false }] }), f.params("alice"));
	const history = await (await m.auditLogs(f.req("admin", "/api/audit-logs?kind=access"))).json();
	assert.deepEqual(history.auditLogs.map((row) => [row.action, row.targetEmail, row.mailboxLocalPart]), [["grant.set", "alice@ex.com", "sales"]]);
	assert.equal((await m.auditLogs(f.req("alice", "/api/audit-logs?kind=access"))).status, 403);
});
