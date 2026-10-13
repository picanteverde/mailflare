import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// picanteverde fork: the daily R2 copy worker (tools/r2-copy/worker.ts).
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-r2-copy-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({ entryPoints: [join(root, "tools/r2-copy/worker.ts")], outfile: join(directory, "worker.mjs"), bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent" });
const { runCopy } = await import(pathToFileURL(join(directory, "worker.mjs")).href);

/** Minimal in-memory R2: list (sorted, cursor), head, get, put; a lock refuses overwrites under a prefix. */
function fakeBucket({ lockedPrefixes = [] } = {}) {
	const objects = new Map();
	let etagCounter = 0;
	return {
		objects,
		async head(key) { const o = objects.get(key); return o ? { key, etag: o.etag, size: o.body.length, customMetadata: o.customMetadata } : null; },
		async get(key) {
			const o = objects.get(key);
			return o ? { key, size: o.body.length, body: o.body, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata, json: async () => JSON.parse(o.body) } : null;
		},
		async put(key, body, options = {}) {
			if (objects.has(key) && lockedPrefixes.some((prefix) => key.startsWith(prefix))) throw new Error(`locked: ${key}`);
			const text = typeof body === "string" ? body : String(body);
			objects.set(key, { body: text, etag: `e${++etagCounter}`, httpMetadata: options.httpMetadata, customMetadata: options.customMetadata ?? {} });
		},
		async list({ limit = 1000, cursor } = {}) {
			const keys = [...objects.keys()].sort();
			const start = cursor ? Number(cursor) : 0;
			const page = keys.slice(start, start + limit);
			const truncated = start + limit < keys.length;
			return { objects: page.map((key) => ({ key, etag: objects.get(key).etag, size: objects.get(key).body.length })), truncated, cursor: truncated ? String(start + limit) : undefined };
		},
	};
}

function setup(count) {
	const SOURCE = fakeBucket();
	const BACKUP = fakeBucket({ lockedPrefixes: ["raw/", "versions/", "manifests/"] });
	for (let i = 0; i < count; i += 1) SOURCE.put(`mail/${String(i).padStart(4, "0")}.eml`, `raw message ${i}`);
	return { env: { SOURCE, BACKUP, BATCH: "25" }, SOURCE, BACKUP };
}
const day1 = new Date("2026-10-14T03:00:00Z");
const day2 = new Date("2026-10-15T03:00:00Z");
const summary = (BACKUP) => JSON.parse(BACKUP.objects.get("_state/last-summary.json").body);

test("a daily pass copies everything across invocations, then idles until the next day", async () => {
	const { env, BACKUP } = setup(60);
	let state;
	for (let run = 0; run < 3; run += 1) state = await runCopy(env, day1);
	assert.equal(state.done, true);
	assert.equal([...BACKUP.objects.keys()].filter((key) => key.startsWith("raw/")).length, 60);
	assert.deepEqual({ ...summary(BACKUP), startedAt: undefined, finishedAt: undefined, firstErrors: undefined }, { day: "2026-10-14", startedAt: undefined, finishedAt: undefined, listed: 60, copied: 60, versioned: 0, bytes: summary(BACKUP).bytes, errors: 0, firstErrors: undefined });
	const manifest = JSON.parse(BACKUP.objects.get("manifests/2026-10-14.json").body);
	assert.equal(manifest.keys.length, 60);
	const before = BACKUP.objects.size;
	await runCopy(env, day1);
	assert.equal(BACKUP.objects.size, before, "same day: nothing to do");
});

test("next day: only new objects copied; changed objects versioned, never overwritten; deletions kept", async () => {
	const { env, SOURCE, BACKUP } = setup(30);
	for (let run = 0; run < 2; run += 1) await runCopy(env, day1);
	await SOURCE.put("mail/new.eml", "brand new");
	await SOURCE.put("mail/0001.eml", "changed content");
	SOURCE.objects.delete("mail/0002.eml");
	for (let run = 0; run < 2; run += 1) await runCopy(env, day2);
	const s = summary(BACKUP);
	assert.equal(s.copied, 1);
	assert.equal(s.versioned, 1);
	assert.equal(s.errors, 0);
	assert.equal(BACKUP.objects.get("raw/mail/0001.eml").body, "raw message 1", "the locked original is untouched");
	assert.ok([...BACKUP.objects.keys()].some((key) => key.startsWith("versions/") && key.endsWith("/mail/0001.eml")));
	assert.ok(BACKUP.objects.has("raw/mail/0002.eml"), "deleted at the source, kept in the copy");
	assert.deepEqual(JSON.parse(BACKUP.objects.get("manifests/2026-10-15.json").body).keys.length, 2);
});

test("errors are recorded in the summary and do not stop the pass", async () => {
	const { env, BACKUP } = setup(10);
	const realGet = env.SOURCE.get;
	env.SOURCE.get = async (key) => { if (key === "mail/0003.eml") throw new Error("boom"); return realGet(key); };
	await runCopy(env, day1);
	const s = summary(BACKUP);
	assert.equal(s.copied, 9);
	assert.equal(s.errors, 1);
	assert.equal(s.firstErrors[0].key, "mail/0003.eml");
});

test("the copy worker never deletes and has no HTTP handler", () => {
	const source = readFileSync(join(root, "tools/r2-copy/worker.ts"), "utf8");
	assert.doesNotMatch(source, /\.delete\(/);
	assert.doesNotMatch(source, /\bfetch\s*\(/);
	assert.doesNotMatch(source, /async fetch\b|fetch:/);
});
