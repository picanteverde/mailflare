import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// picanteverde fork, Phase 6: accounts are logins; admin actions are guarded and audited.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-access-accounts-"));
after(() => rmSync(directory, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession, getUserFromSession } from "./src/lib/auth/session.ts";
			export { generateApiKey } from "./src/lib/api-keys.ts";
			export { authenticateApiKeyValue } from "./src/lib/api/key-auth.ts";
			export { POST as dashboardCreate } from "./src/app/api/accounts/route.ts";
			export { POST as apiCreate } from "./src/app/api/v1/accounts/route.ts";
			export { PATCH as patchAccount } from "./src/app/api/accounts/[id]/route.ts";
			export { DELETE as revokeSessions } from "./src/app/api/accounts/[id]/sessions/route.ts";
			export { DELETE as resetTotp } from "./src/app/api/accounts/[id]/totp/route.ts";
		`,
		resolveDir: root,
		sourcefile: "access-accounts-test-entry.ts",
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
	// No license row at all: account management must not depend on one.
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, totp_enabled, created_at) VALUES
			('primary', 'primary@ex.com', 'x', 'Primary', 'admin', 1, 1, 1),
			('admin2', 'admin2@ex.com', 'x', 'Second admin', 'admin', 0, 1, 1),
			('alice', 'alice@ex.com', 'x', 'Alice', 'user', 0, 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d', 'primary', 'ex.com', 'manual', 'active', 1);
	`);
	const env = { DB: database, MAILFLARE_RUNTIME: "node", PUBLIC_APP_URL: ORIGIN };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const sessions = {};
	for (const id of ["primary", "admin2", "alice"]) sessions[id] = await m.createSession(env, id);
	const key = m.generateApiKey();
	database.db.prepare("INSERT INTO api_keys (id, user_id, name, prefix, key_hash, scopes, created_at) VALUES ('k', 'primary', 'k', ?, ?, '[\"accounts\"]', 1)").run(key.prefix, key.hash);
	const req = (user, path, init = {}) => new Request(`${ORIGIN}${path}`, {
		...init,
		headers: { Authorization: `Bearer ${sessions[user]}`, "Content-Type": "application/json", Origin: ORIGIN },
	});
	const params = (id) => ({ params: Promise.resolve({ id }) });
	const audit = (action, target) => database.db.prepare("SELECT actor_user_id AS actor, metadata FROM audit_logs WHERE action = ? AND target_user_id = ?").all(action, target).map((row) => ({ ...row }));
	return { database, env, sessions, key, req, params, audit };
}

test("an account is a login only: no mailbox, no license, any domain or a username", async (t) => {
	const f = await fixture(t);
	const create = (user, body) => m.dashboardCreate(f.req(user, "/api/accounts", { method: "POST", body: JSON.stringify(body) }));
	const res = await create("primary", { login: "Sam@Other-Domain.org", password: "long-enough-pass", role: "user" });
	assert.equal(res.status, 201);
	const sam = (await res.json()).account;
	assert.equal(sam.email, "sam@other-domain.org");
	assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM mailboxes").get().n, 0, "no mailbox is created");
	assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM mailbox_access").get().n, 0, "and no grant");
	assert.equal(f.audit("account.create", sam.id).length, 1);
	assert.equal((await create("admin2", { login: "reception", password: "long-enough-pass" })).status, 201, "plain username, any admin");
	assert.equal((await create("primary", { login: "reception", password: "long-enough-pass" })).status, 409);
	assert.equal((await create("primary", { login: "no spaces!", password: "long-enough-pass" })).status, 400);
	assert.equal((await create("primary", { login: "short-pass", password: "elevenchars" })).status, 400);
	assert.equal((await create("admin2", { login: "boss", password: "long-enough-pass", role: "admin" })).status, 403, "only the primary creates admins");
	assert.equal((await create("alice", { login: "x", password: "long-enough-pass" })).status, 403);
	const api = await m.apiCreate(new Request(`${ORIGIN}/api/v1/accounts`, { method: "POST", headers: { Authorization: `Bearer ${f.key.fullKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ login: "bot@ex.com", password: "long-enough-pass" }) }));
	assert.equal(api.status, 201);
});

test("primary and last-admin protection", async (t) => {
	const f = await fixture(t);
	const patch = (user, id, body) => m.patchAccount(f.req(user, `/api/accounts/${id}`, { method: "PATCH", body: JSON.stringify({ name: "n", role: "admin", disabled: false, ...body }) }), f.params(id));
	assert.equal((await patch("primary", "primary", { disabled: true })).status, 409);
	assert.equal((await patch("primary", "primary", { role: "user" })).status, 409);
	assert.equal((await patch("admin2", "primary", { disabled: true })).status, 403, "admins can't manage the primary");
	assert.equal((await patch("admin2", "alice", { role: "admin" })).status, 403, "role changes are the primary's");
	// Without a primary flag, the last enabled admin still can't be removed.
	f.database.db.exec("UPDATE users SET is_primary_admin = 0 WHERE id = 'primary'; UPDATE users SET disabled = 1 WHERE id = 'admin2'");
	const last = await patch("primary", "primary", { disabled: true });
	assert.equal(last.status, 409);
	assert.equal((await last.json()).code, "last_admin");
});

test("disable, password reset, TOTP reset and revoke end sessions and API keys; one audit row each", async (t) => {
	const f = await fixture(t);
	const aliceKey = m.generateApiKey();
	f.database.db.prepare("INSERT INTO api_keys (id, user_id, name, prefix, key_hash, scopes, created_at) VALUES ('ak', 'alice', 'k', ?, ?, '[]', 1)").run(aliceKey.prefix, aliceKey.hash);
	assert.ok(await m.authenticateApiKeyValue(f.env, aliceKey.fullKey));

	const revoked = await m.revokeSessions(f.req("admin2", "/api/accounts/alice/sessions", { method: "DELETE" }), f.params("alice"));
	assert.equal(revoked.status, 200);
	assert.equal((await revoked.json()).revoked, 1);
	assert.equal(await m.getUserFromSession(f.env, f.sessions.alice), null);
	assert.equal(await m.authenticateApiKeyValue(f.env, aliceKey.fullKey), null, "keys created before the revocation die");
	assert.equal(f.audit("session.revoke", "alice").length, 1);
	assert.equal(f.audit("session.revoke", "alice")[0].actor, "admin2");

	// A new session after the revocation works (clock moves past the revoked second).
	f.database.db.exec("UPDATE users SET sessions_revoked_at = sessions_revoked_at - 2 WHERE id = 'alice'");
	const fresh = await m.createSession(f.env, "alice");
	assert.ok(await m.getUserFromSession(f.env, fresh));

	const patch = (body) => m.patchAccount(f.req("primary", "/api/accounts/alice", { method: "PATCH", body: JSON.stringify({ name: "Alice", role: "user", disabled: false, ...body }) }), f.params("alice"));
	assert.equal((await patch({ password: "brand-new-password" })).status, 200);
	assert.equal(await m.getUserFromSession(f.env, fresh), null);
	const reset = f.audit("credentials.password_reset", "alice");
	assert.equal(reset.length, 1);
	assert.deepEqual(JSON.parse(reset[0].metadata), { by_admin: true, target_is_admin: false });
	assert.equal((await patch({ password: "short" })).status, 400);

	assert.equal((await patch({ disabled: true })).status, 200);
	assert.equal(f.audit("account.disable", "alice").length, 1);
	assert.equal((await patch({ disabled: false })).status, 200);
	assert.equal(f.audit("account.enable", "alice").length, 1);
	assert.equal((await patch({})).status, 200);
	assert.equal(f.audit("account.update", "alice").length, 0, "no change, no row");

	const totp = await m.resetTotp(f.req("primary", "/api/accounts/alice/totp", { method: "DELETE" }), f.params("alice"));
	assert.equal(totp.status, 200);
	const row = f.database.db.prepare("SELECT totp_enabled AS on_, totp_secret AS secret FROM users WHERE id = 'alice'").get();
	assert.deepEqual({ ...row }, { on_: 0, secret: null });
	assert.equal(f.audit("credentials.totp_reset", "alice").length, 1);

	// Plain users can't do any of it.
	assert.equal((await m.revokeSessions(f.req("alice", "/api/accounts/admin2/sessions", { method: "DELETE" }), f.params("admin2"))).status, 403);
});
