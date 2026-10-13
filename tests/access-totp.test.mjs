import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { hashSync } from "bcryptjs";

// picanteverde fork, Phase 6b: mandatory TOTP enforced in the shared auth path, and backoff.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-access-totp-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const routes = [];
const walk = (dir) => {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path);
		else if (name === "route.ts") routes.push(path.slice(root.length + 1));
	}
};
walk(join(root, "src/app/api"));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { generateApiKey } from "./src/lib/api-keys.ts";
			export { authenticateApiKeyValue } from "./src/lib/api/key-auth.ts";
			export { totpEnrollmentGate, isTotpGateExempt } from "./src/lib/auth/totp-gate.ts";
			export { updateManagedAccount } from "./src/lib/accounts/admin.ts";
			export { backoffDelaySeconds } from "./src/lib/auth/backoff.ts";
			${routes.map((path, index) => `export * as route${index} from "./${path}";`).join("\n")}
		`,
		resolveDir: root,
		sourcefile: "access-totp-test-entry.ts",
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
const urlFor = (path) => `${ORIGIN}/${path.replace(/^src\/app\//, "").replace(/\/route\.ts$/, "").replace(/\[([^\]]+)\]/g, "x")}`;

async function fixture(t) {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await m.applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.prepare(`INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, totp_enabled, created_at) VALUES
		('pending', 'pending@ex.com', ?, 'Pending admin', 'admin', 1, 0, 1),
		('enrolled', 'enrolled@ex.com', ?, 'Enrolled', 'admin', 0, 1, 1),
		('other', 'other@ex.com', ?, 'Other admin', 'admin', 0, 1, 1)`).run(hashSync("right-password", 4), hashSync("right-password", 4), hashSync("x", 4));
	database.db.exec(`
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d', 'pending', 'ex.com', 'manual', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb', 'pending', 'd', 'hello', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, can_receive, can_send, created_at) VALUES ('g1', 'mb', 'pending', 1, 1, 1), ('g2', 'mb', 'enrolled', 1, 1, 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES ('msg', 'pending', 'mb', 'inbound', 'x@y.z', 'hello@ex.com', 'SECRET-SUBJECT', 'received', 1);
	`);
	const env = { DB: database, MAILFLARE_RUNTIME: "node", BUCKET: { get: async () => null, put: async () => ({}), delete: async () => {}, list: async () => ({ objects: [] }) } };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	t.mock.method(globalThis, "fetch", async () => { throw new Error("tests must never contact a real service"); });
	return { database, env, pending: await m.createSession(env, "pending"), enrolled: await m.createSession(env, "enrolled") };
}

const sessionRequest = (url, token, method = "GET", body) => new Request(url, {
	method,
	headers: { Authorization: `Bearer ${token}`, Cookie: `ep_session=${token}`, Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.1" },
	...(method === "GET" ? {} : { body: body ?? "{}" }),
});

test("the Worker gate answers 403 totp_enrollment_required on every non-exempt /api route", async (t) => {
	const f = await fixture(t);
	let gated = 0;
	for (const path of routes) {
		const url = urlFor(path);
		const pathname = new URL(url).pathname;
		const response = await m.totpEnrollmentGate(f.env, sessionRequest(url, f.pending));
		if (m.isTotpGateExempt(pathname)) {
			assert.equal(response, null, pathname);
			continue;
		}
		assert.ok(response, `${pathname} must be gated`);
		assert.equal(response.status, 403, pathname);
		assert.equal((await response.json()).code, "totp_enrollment_required", pathname);
		gated += 1;
		assert.equal(await m.totpEnrollmentGate(f.env, sessionRequest(url, f.enrolled)), null, `${pathname} open once enrolled`);
	}
	assert.ok(gated > 120, `only ${gated} routes gated`);
	// The exempt list stays small and deliberate.
	for (const pathname of ["/api/messages", "/api/mailboxes", "/api/send", "/api/drafts", "/api/contacts", "/api/accounts", "/api/backups", "/api/export/messages", "/api/settings/mfa/disable", "/api/settings/mfa/recovery-codes"]) {
		assert.equal(m.isTotpGateExempt(pathname), false, pathname);
	}
});

test("behind the gate, every route handler also denies an account without TOTP", async (t) => {
	const f = await fixture(t);
	// Handlers that may answer before enrollment, by design.
	const allowed = new Set([
		"GET src/app/api/auth/me/route.ts", // reports totpEnrollmentRequired
		"GET src/app/api/settings/mfa/route.ts", // enrollment status
		"GET src/app/api/branding/route.ts", // public name and logo
		"GET src/app/api/setup/status/route.ts", // first-run status, no account data
		"POST src/app/api/seed/route.ts", // dev only: the production build compiles it to a bare 403
	]);
	const params = { params: Promise.resolve(new Proxy({}, { get: (_target, key) => (key === "then" ? undefined : ({ messageId: "msg", attachmentId: "a", userId: "pending", provider: "cloudflare" })[key] ?? "mb") })) };
	let checked = 0;
	for (const [index, path] of routes.entries()) {
		const handlers = m[`route${index}`];
		for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
			if (typeof handlers[method] !== "function") continue;
			if (path.startsWith("src/app/api/seed/") || allowed.has(`${method} ${path}`)) continue;
			checked += 1;
			let status;
			let text = "";
			try {
				const response = await handlers[method](sessionRequest(`${urlFor(path)}?mailboxId=mb&address=x%40y.z`, f.pending, method), params);
				status = response.status;
				text = await response.text().catch(() => "");
			} catch {
				status = "threw";
			}
			assert.ok(status === "threw" || status >= 400, `${method} ${path} answered ${status} before TOTP enrollment`);
			assert.doesNotMatch(text, /SECRET-SUBJECT/, `${method} ${path} leaked mail`);
		}
	}
	assert.ok(checked > 200, `only ${checked} handlers checked`);
});

test("enrollment is the only way forward; TOTP can't be turned off; keys need an enrolled account", async (t) => {
	const f = await fixture(t);
	const handler = (path, method) => m[`route${routes.indexOf(path)}`][method];
	const me = await (await handler("src/app/api/auth/me/route.ts", "GET")(sessionRequest(`${ORIGIN}/api/auth/me`, f.pending))).json();
	assert.equal(me.user.totpEnrollmentRequired, true);
	assert.equal(me.hasMailboxes, false);
	const status = await handler("src/app/api/settings/mfa/route.ts", "GET")(sessionRequest(`${ORIGIN}/api/settings/mfa`, f.pending));
	assert.equal(status.status, 200);
	const blocked = await handler("src/app/api/messages/route.ts", "GET")(sessionRequest(`${ORIGIN}/api/messages`, f.pending));
	assert.ok(blocked.status === 401 || blocked.status === 403);
	const disable = await handler("src/app/api/settings/mfa/disable/route.ts", "POST")(sessionRequest(`${ORIGIN}/api/settings/mfa/disable`, f.enrolled, "POST", JSON.stringify({ password: "right-password", code: "123456" })));
	assert.equal(disable.status, 403);
	assert.equal((await disable.json()).code, "totp_required");

	const key = m.generateApiKey();
	f.database.db.prepare("INSERT INTO api_keys (id, user_id, name, prefix, key_hash, scopes, created_at) VALUES ('k', 'pending', 'k', ?, ?, '[]', 1)").run(key.prefix, key.hash);
	assert.equal(await m.authenticateApiKeyValue(f.env, key.fullKey), null);
	f.database.db.exec("UPDATE users SET totp_enabled = 1 WHERE id = 'pending'");
	assert.ok(await m.authenticateApiKeyValue(f.env, key.fullKey));
});

test("sign-in backoff: increasing delays per login and client, never a lock", async (t) => {
	const f = await fixture(t);
	assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 30].map(m.backoffDelaySeconds), [0, 0, 0, 0, 1, 2, 4, 900]);
	const sessions = () => f.database.db.prepare("SELECT count(*) AS n FROM sessions").get().n;
	// A successful sign-in ends in Next's cookies(), which only works inside a real request; reaching
	// it (with a challenge or session issued) is the success signal here.
	const login = async (password, ip, email = "enrolled@ex.com") => {
		const before = sessions() + f.database.db.prepare("SELECT count(*) AS n FROM login_challenges").get().n;
		try {
			return await handlerFor("src/app/api/auth/login/route.ts")(new Request(`${ORIGIN}/api/auth/login`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": ip },
				body: JSON.stringify({ email, password }),
			}));
		} catch (error) {
			assert.match(String(error), /cookies/);
			const after = sessions() + f.database.db.prepare("SELECT count(*) AS n FROM login_challenges").get().n;
			assert.equal(after, before + 1, "a session or MFA challenge was issued");
			return { status: 200, headers: new Headers() };
		}
	};
	const handlerFor = (path) => m[`route${routes.indexOf(path)}`].POST;
	// Four failures are free; from then on each attempt waits 1s, 2s, 4s ...
	for (let attempt = 1; attempt <= 4; attempt += 1) assert.equal((await login("wrong", "198.51.100.7")).status, 401, `attempt ${attempt}`);
	const waiting = await login("right-password", "198.51.100.7");
	assert.equal(waiting.status, 429, "the right password still waits out the delay from the attacker's client");
	assert.ok(Number(waiting.headers.get("Retry-After")) >= 1);
	// The real user on another network is unaffected, and success clears their own counter.
	assert.equal((await login("right-password", "192.0.2.20")).status, 200);
	// Unknown logins back off the same way, so the delay reveals nothing.
	for (let attempt = 1; attempt <= 4; attempt += 1) await login("wrong", "198.51.100.7", "nobody@ex.com");
	assert.equal((await login("wrong", "198.51.100.7", "nobody@ex.com")).status, 429);
	// The delay ends on its own: move the clock past it and the right password works.
	f.database.db.exec("UPDATE login_backoff SET next_allowed_at = 0");
	assert.equal((await login("right-password", "198.51.100.7")).status, 200);
	assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM login_backoff WHERE failures > 0 AND next_allowed_at > 0").get().n, 0);
});

test("two concurrent requests can't remove the last two admins", async (t) => {
	const f = await fixture(t);
	// No primary flag and two enabled admins (enrolled, other), each disabling itself at once.
	// Both pass the read-time check (one other admin left); the conditional write lets only one through.
	f.database.db.exec("UPDATE users SET is_primary_admin = 0, disabled = 1 WHERE id = 'pending'");
	const results = await Promise.allSettled([
		m.updateManagedAccount(f.env, "enrolled", "enrolled", { disabled: true }),
		m.updateManagedAccount(f.env, "other", "other", { disabled: true }),
	]);
	const enabledAdmins = f.database.db.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get().n;
	assert.equal(enabledAdmins, 1, "exactly one admin remains");
	assert.equal(results.filter((result) => result.status === "rejected" && result.reason.code === "last_admin").length, 1);
});
