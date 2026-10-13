/*
 * picanteverde fork: daily incremental copy of mailflare's R2 bucket (raw .eml, attachments,
 * Drive, in-app backups) into a dedicated, bucket-locked backup bucket. See
 * docs/picanteverde-disaster-recovery.md.
 *
 * - No HTTP handler: it only runs from its cron.
 * - It never deletes anything, in either bucket (no delete call exists in this file; a test
 *   checks that). Objects deleted from the source stay in the copy.
 * - Locked keys are never overwritten: a new key is copied to `raw/<key>`; if the source object
 *   later changes (new etag), the new version goes to `versions/<etag>/<key>`.
 * - A full pass runs once per UTC day, continued across cron invocations with a cursor kept in
 *   `_state/` (the only prefix outside the bucket lock). Each finished pass writes
 *   `manifests/<date>.json` (what was copied) and `_state/last-summary.json` (counts, errors),
 *   which the bot checks and reports to Teams.
 */

export interface Env {
	SOURCE: R2Bucket;
	BACKUP: R2Bucket;
	/** Objects handled per invocation; keeps each run well inside subrequest and CPU limits. */
	BATCH?: string;
}

type State = {
	day: string;
	cursor: string | null;
	done: boolean;
	startedAt: string;
	listed: number;
	copied: number;
	versioned: number;
	bytes: number;
	errors: { key: string; error: string }[];
	copiedKeys: string[];
};

const STATE_KEY = "_state/pass.json";
const SUMMARY_KEY = "_state/last-summary.json";

function utcDay(now: Date): string {
	return now.toISOString().slice(0, 10);
}

async function readState(env: Env): Promise<State | null> {
	const object = await env.BACKUP.get(STATE_KEY);
	return object ? ((await object.json()) as State) : null;
}

function freshState(now: Date): State {
	return { day: utcDay(now), cursor: null, done: false, startedAt: now.toISOString(), listed: 0, copied: 0, versioned: 0, bytes: 0, errors: [], copiedKeys: [] };
}

async function copyOne(env: Env, state: State, key: string, etag: string): Promise<void> {
	const target = `raw/${key}`;
	const existing = await env.BACKUP.head(target);
	if (existing && existing.customMetadata?.sourceEtag === etag) return;
	const destination = existing ? `versions/${etag}/${key}` : target;
	if (existing && (await env.BACKUP.head(destination))) return;
	const source = await env.SOURCE.get(key);
	if (!source) return; // deleted between list and copy; the next pass sees the truth
	await env.BACKUP.put(destination, source.body, {
		httpMetadata: source.httpMetadata,
		customMetadata: { ...source.customMetadata, sourceEtag: etag, copiedAt: new Date().toISOString() },
	});
	state.copiedKeys.push(destination);
	state.bytes += source.size;
	if (existing) state.versioned += 1;
	else state.copied += 1;
}

/** One cron invocation: continue today's pass, or start a new one on a new UTC day. */
export async function runCopy(env: Env, now = new Date()): Promise<State> {
	let state = await readState(env);
	if (!state || state.day !== utcDay(now)) state = freshState(now);
	if (state.done) return state;

	const batch = Math.max(1, Math.min(Number(env.BATCH ?? 200), 500));
	const page = await env.SOURCE.list({ limit: batch, ...(state.cursor ? { cursor: state.cursor } : {}) });
	for (const object of page.objects) {
		state.listed += 1;
		try {
			await copyOne(env, state, object.key, object.etag);
		} catch (error) {
			state.errors.push({ key: object.key, error: error instanceof Error ? error.message : String(error) });
		}
	}
	state.cursor = page.truncated ? page.cursor : null;
	if (!page.truncated) {
		state.done = true;
		const summary = { day: state.day, startedAt: state.startedAt, finishedAt: now.toISOString(), listed: state.listed, copied: state.copied, versioned: state.versioned, bytes: state.bytes, errors: state.errors.length, firstErrors: state.errors.slice(0, 20) };
		// Manifests are written once per day under the bucket lock; the summary lives in _state/.
		const manifest = `manifests/${state.day}.json`;
		if (!(await env.BACKUP.head(manifest))) {
			await env.BACKUP.put(manifest, JSON.stringify({ ...summary, keys: state.copiedKeys }), { httpMetadata: { contentType: "application/json" } });
		}
		await env.BACKUP.put(SUMMARY_KEY, JSON.stringify(summary), { httpMetadata: { contentType: "application/json" } });
		state.copiedKeys = [];
	}
	await env.BACKUP.put(STATE_KEY, JSON.stringify(state), { httpMetadata: { contentType: "application/json" } });
	return state;
}

export default {
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(runCopy(env).then(() => undefined));
	},
};
