import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// picanteverde fork, Phase 4: routes that used to bypass can() (access design §2, §6).
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-access-routes-"));
after(() => rmSync(directory, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { generateApiKey } from "./src/lib/api-keys.ts";
			export { authenticateApiKeyValue } from "./src/lib/api/key-auth.ts";
			export { processOutboundQueue } from "./src/lib/email/send.ts";
			export { GET as listMessages } from "./src/app/api/messages/route.ts";
			export { GET as countMessages } from "./src/app/api/messages/counts/route.ts";
			export { GET as getMessage } from "./src/app/api/messages/[messageId]/route.ts";
			export { GET as getOriginal } from "./src/app/api/messages/[messageId]/original/route.ts";
			export { POST as bulk } from "./src/app/api/messages/bulk/route.ts";
			export { GET as listDrafts } from "./src/app/api/drafts/route.ts";
			export { GET as getDraft } from "./src/app/api/drafts/[id]/route.ts";
			export { GET as listMailboxes } from "./src/app/api/mailboxes/route.ts";
			export { PATCH as updateMailbox, DELETE as deleteMailbox } from "./src/app/api/mailboxes/[id]/route.ts";
			export { PATCH as setTrashRetention } from "./src/app/api/settings/trash-retention/route.ts";
			export { GET as getContact } from "./src/app/api/contacts/route.ts";
			export { upsertContactFromAddress } from "./src/lib/contacts/service.ts";
			export { GET as listThread } from "./src/app/api/messages/[messageId]/thread/route.ts";
		`,
		resolveDir: root,
		sourcefile: "access-routes-test-entry.ts",
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
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES
			('admin', 'admin@ex.com', 'x', 'Admin', 'admin', 1, 1),
			('alice', 'alice@ex.com', 'x', 'Alice', 'user', 0, 1),
			('bob', 'bob@ex.com', 'x', 'Bob', 'user', 0, 1),
			('nobody', 'nobody@ex.com', 'x', 'Nobody', 'user', 0, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d', 'admin', 'ex.com', 'manual', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES
			('team', 'admin', 'd', 'team', 1),
			('private', 'admin', 'd', 'private', 1);
		-- admin manages but holds no grant on either mailbox; alice reads team; bob reads+sends team.
		INSERT INTO mailbox_access (id, mailbox_id, user_id, can_receive, can_send, created_at) VALUES
			('g1', 'team', 'alice', 1, 0, 1),
			('g2', 'team', 'bob', 1, 1, 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, raw_r2_key, created_at) VALUES
			('in-team', 'admin', 'team', 'inbound', 'x@y.z', 'team@ex.com', 'team mail', 'received', 'raw/in-team', 1),
			('in-private', 'admin', 'private', 'inbound', 'x@y.z', 'private@ex.com', 'private mail', 'received', 'raw/in-private', 2),
			('legacy', 'nobody', NULL, 'inbound', 'x@y.z', 'nobody@ex.com', 'no mailbox', 'received', NULL, 3),
			('bob-draft', 'bob', 'team', 'outbound', 'team@ex.com', 'x@y.z', 'bob draft', 'draft', NULL, 4),
			('alice-draft', 'alice', 'team', 'outbound', 'team@ex.com', 'x@y.z', 'alice draft', 'draft', NULL, 5),
			('trashed', 'admin', 'team', 'inbound', 'x@y.z', 'team@ex.com', 'old', 'trash', NULL, 6);
		-- Every account here has finished TOTP enrollment (mandatory since Phase 6b).
		UPDATE users SET totp_enabled = 1;
	`);
	const reads = [];
	const env = {
		DB: database,
		MAILFLARE_RUNTIME: "node",
		BUCKET: { get: async (key) => { reads.push(key); const bytes = new TextEncoder().encode("Subject: x\r\n\r\nraw"); return { body: new Blob([bytes]).stream(), size: bytes.length, httpMetadata: {}, arrayBuffer: async () => bytes.buffer, text: async () => "Subject: x\r\n\r\nraw" }; }, put: async () => ({}), delete: async () => {} },
	};
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const sessions = {};
	for (const id of ["admin", "alice", "bob", "nobody"]) sessions[id] = await m.createSession(env, id);
	const req = (user, path, init = {}) => new Request(`https://mailflare.test${path}`, {
		...init,
		headers: { Authorization: `Bearer ${sessions[user]}`, "Content-Type": "application/json", Origin: "https://mailflare.test", ...(init.headers ?? {}) },
	});
	const ids = async (response) => (await response.json()).messages.map((row) => row.id).sort();
	return { database, env, req, ids, reads };
}

test("lists come from grants only: no messages.user_id fallback, no other accounts' drafts", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(await f.ids(await m.listMessages(f.req("nobody", "/api/messages"))), []);
	assert.deepEqual(await f.ids(await m.listMessages(f.req("admin", "/api/messages"))), []);
	// alice: team mail, not bob's draft, and not even her own draft (she cannot send from team).
	assert.deepEqual(await f.ids(await m.listMessages(f.req("alice", "/api/messages"))), ["in-team", "trashed"]);
	// bob: team mail plus his own draft, never alice's.
	assert.deepEqual(await f.ids(await m.listMessages(f.req("bob", "/api/messages"))), ["bob-draft", "in-team", "trashed"]);
	assert.equal((await m.listMessages(f.req("alice", "/api/messages?mailboxId=private"))).status, 404);
	assert.equal((await m.listMessages(f.req("admin", "/api/messages?mailboxId=team"))).status, 404);
	const counts = await (await m.countMessages(f.req("nobody", "/api/messages/counts"))).json();
	assert.equal(JSON.stringify(counts).includes("in-private"), false);
});

test("single messages, drafts and the original .eml answer 404 without the right grant, before R2 is read", async (t) => {
	const f = await fixture(t);
	const params = (messageId) => ({ params: Promise.resolve({ messageId }) });
	assert.equal((await m.getMessage(f.req("alice", "/x"), params("in-team"))).status, 200);
	assert.equal((await m.getMessage(f.req("alice", "/x"), params("in-private"))).status, 404);
	assert.equal((await m.getMessage(f.req("nobody", "/x"), params("legacy"))).status, 404);
	assert.equal((await m.getMessage(f.req("alice", "/x"), params("bob-draft"))).status, 404);
	assert.equal((await m.getMessage(f.req("admin", "/x"), params("in-team"))).status, 404);
	f.reads.length = 0;
	assert.equal((await m.getOriginal(f.req("admin", "/x"), params("in-private"))).status, 404);
	assert.equal((await m.getOriginal(f.req("alice", "/x"), params("in-private"))).status, 404);
	assert.deepEqual(f.reads, [], "no R2 read for a denied request");
	assert.equal((await m.getOriginal(f.req("alice", "/x"), params("in-team"))).status, 200);
	assert.deepEqual(f.reads, ["raw/in-team"]);

	const draft = (id) => ({ params: Promise.resolve({ id }) });
	assert.equal((await m.getDraft(f.req("bob", "/x"), draft("bob-draft"))).status, 200);
	assert.equal((await m.getDraft(f.req("alice", "/x"), draft("bob-draft"))).status, 404);
	assert.equal((await m.getDraft(f.req("alice", "/x"), draft("alice-draft"))).status, 404, "author without send");
	const drafts = async (user) => (await (await m.listDrafts(f.req(user, "/api/drafts"))).json()).drafts.map((row) => row.id);
	assert.deepEqual(await drafts("bob"), ["bob-draft"]);
	assert.deepEqual(await drafts("alice"), []);
	// The grant is re-read: revoking bob's send hides his draft at once.
	f.database.db.exec("UPDATE mailbox_access SET can_send = 0 WHERE id = 'g2'");
	assert.equal((await m.getDraft(f.req("bob", "/x"), draft("bob-draft"))).status, 404);
});

test("organizing needs receive; destroying mail and mailbox settings are admin-only", async (t) => {
	const f = await fixture(t);
	const bulk = (user, body) => m.bulk(f.req(user, "/api/messages/bulk", { method: "POST", body: JSON.stringify(body) }));
	assert.equal((await bulk("alice", { messageIds: ["in-team"], action: "archive" })).status, 200);
	assert.equal(f.database.db.prepare("SELECT status FROM messages WHERE id = 'in-team'").get().status, "archived");
	assert.equal((await bulk("alice", { messageIds: ["in-private"], action: "archive" })).status, 404);
	assert.equal((await bulk("bob", { messageIds: ["trashed"], action: "delete" })).status, 404, "permanent delete is admin-only");
	assert.ok(f.database.db.prepare("SELECT id FROM messages WHERE id = 'trashed'").get());

	const mailboxParams = { params: Promise.resolve({ id: "team" }) };
	const patch = (user) => m.updateMailbox(f.req(user, "/api/mailboxes/team", { method: "PATCH", body: JSON.stringify({ signature: `by ${user}` }) }), mailboxParams);
	assert.equal((await patch("bob")).status, 404);
	assert.equal((await patch("admin")).status, 200, "admin edits settings without a mail grant");
	assert.equal(f.database.db.prepare("SELECT signature FROM mailboxes WHERE id = 'team'").get().signature, "by admin");
	assert.equal((await m.deleteMailbox(f.req("bob", "/api/mailboxes/team", { method: "DELETE" }), mailboxParams)).status, 403);

	const retention = (user) => m.setTrashRetention(f.req(user, "/api/settings/trash-retention", { method: "PATCH", body: JSON.stringify({ days: 7 }) }));
	assert.equal((await retention("bob")).status, 403);
	assert.equal((await retention("admin")).status, 200);
});

test("no silent personal mailbox: an account without grants sees no mailboxes", async (t) => {
	const f = await fixture(t);
	const list = async (user) => (await (await m.listMailboxes(f.req(user, "/api/mailboxes"))).json()).mailboxes.map((row) => row.id).sort();
	assert.deepEqual(await list("nobody"), []);
	assert.deepEqual(await list("admin"), []);
	assert.deepEqual(await list("alice"), ["team"]);
	assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM mailboxes").get().n, 2);
});

test("API keys never reach past the account's current grants", async (t) => {
	const f = await fixture(t);
	const key = m.generateApiKey();
	f.database.db.prepare("INSERT INTO api_keys (id, user_id, name, prefix, key_hash, scopes, mailbox_scope_enabled, created_at) VALUES ('k', 'alice', 'k', ?, ?, '[\"messages:read\"]', 1, 1)").run(key.prefix, key.hash);
	f.database.db.exec("INSERT INTO mcp_key_mailboxes (key_id, mailbox_id) VALUES ('k', 'team'), ('k', 'private')");
	assert.deepEqual((await m.authenticateApiKeyValue(f.env, key.fullKey)).mailboxIds, ["team"]);
	f.database.db.exec("DELETE FROM mailbox_access WHERE id = 'g1'");
	assert.deepEqual((await m.authenticateApiKeyValue(f.env, key.fullKey)).mailboxIds, []);
	f.database.db.exec("UPDATE users SET disabled = 1 WHERE id = 'alice'");
	assert.equal(await m.authenticateApiKeyValue(f.env, key.fullKey), null);
});

test("the outbound queue re-checks send at dequeue", async (t) => {
	const f = await fixture(t);
	f.database.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES ('out', 'bob', 'team', 'outbound', 'team@ex.com', 'x@y.z', 's', 'queued', 7);
		INSERT INTO outbound_jobs (id, user_id, message_id, status, payload, created_at, updated_at) VALUES ('job', 'bob', 'out', 'queued', '{"userId":"bob","from":"team@ex.com","to":"x@y.z","subject":"s","mailboxId":"team"}', 7, 7);
		UPDATE mailbox_access SET can_send = 0 WHERE id = 'g2';
	`);
	await m.processOutboundQueue(f.env, { jobId: "job", messageId: "out", scheduledAt: new Date(0).toISOString() });
	const job = f.database.db.prepare("SELECT status, error FROM outbound_jobs WHERE id = 'job'").get();
	assert.equal(job.status, "failed");
	assert.match(job.error, /send permission/);
	assert.equal(f.database.db.prepare("SELECT status FROM messages WHERE id = 'out'").get().status, "failed");
});

test("contacts are per mailbox: reading one mailbox reveals nothing learned by another", async (t) => {
	const f = await fixture(t);
	// Only the private mailbox has corresponded with secret@partner.z; team has seen shared@z.z too.
	await m.upsertContactFromAddress(f.env, { userId: "admin", mailboxId: "private", address: "Secret Partner <secret@partner.z>", source: "inbound" });
	await m.upsertContactFromAddress(f.env, { userId: "admin", mailboxId: "private", address: "Private Name <shared@z.z>", source: "inbound" });
	await m.upsertContactFromAddress(f.env, { userId: "admin", mailboxId: "team", address: "Team Name <shared@z.z>", source: "inbound" });
	const contact = async (address) => (await (await m.getContact(f.req("alice", `/api/contacts?mailboxId=team&address=${encodeURIComponent(address)}`))).json()).contact;
	assert.deepEqual(await contact("secret@partner.z"), { email: "secret@partner.z", displayName: null, hasAvatar: false, source: null, blocked: false, lastSeenAt: null });
	const shared = await contact("shared@z.z");
	assert.equal(shared.displayName, "Team Name");
	assert.equal(shared.mailboxId, "team");
	assert.equal((await m.getContact(f.req("alice", "/api/contacts?mailboxId=private&address=secret%40partner.z"))).status, 404);
	// Message lists name senders from the row's own mailbox only.
	f.database.db.exec("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES ('from-shared', 'admin', 'team', 'inbound', 'shared@z.z', 'team@ex.com', 'hi', 'received', 9)");
	const rows = (await (await m.listMessages(f.req("alice", "/api/messages?mailboxId=team"))).json()).messages;
	assert.equal(rows.find((row) => row.id === "from-shared").fromContactName, "Team Name");
});
