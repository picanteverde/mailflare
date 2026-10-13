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
 * - A pass is continued across cron invocations with a cursor kept in `_state/` (the only prefix
 *   outside the bucket lock). A new pass starts only once the previous one is done and its UTC day
 *   has passed, so an unfinished pass is never restarted (QA): if the bucket outgrows one day's
 *   capacity, the pass simply spans days, and `_state/pass.json` shows it (startedAt, done) so the
 *   bot can alert on passes longer than 24h.
 * - Each run that copied something writes `manifests/<pass day>/<run>.json` (its keys); each
 *   finished pass writes `_state/last-summary.json` (counts, errors), which the bot checks.
 */

export interface Env {
	SOURCE: R2Bucket;
	BACKUP: R2Bucket;
	/** Objects handled per invocation; keeps each run well inside subrequest and CPU limits. */
	BATCH?: string;
}

type State = {
	/** UTC day the pass started; it keeps this day until done, however many days it spans. */
	day: string;
	cursor: string | null;
	done: boolean;
	startedAt: string;
	run: number;
	listed: number;
	copied: number;
	versioned: number;
	bytes: number;
	errorCount: number;
	/** The first MAX_ERRORS errors only, so the state file stays small. */
	errors: { key: string; error: string }[];
};

const MAX_ERRORS = 100;

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
	return { day: utcDay(now), cursor: null, done: false, startedAt: now.toISOString(), run: 0, listed: 0, copied: 0, versioned: 0, bytes: 0, errorCount: 0, errors: [] };
}

async function copyOne(env: Env, state: State, copiedKeys: string[], key: string, etag: string): Promise<void> {
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
	copiedKeys.push(destination);
	state.bytes += source.size;
	if (existing) state.versioned += 1;
	else state.copied += 1;
}

/** One cron invocation: continue today's pass, or start a new one on a new UTC day. */
export async function runCopy(env: Env, now = new Date()): Promise<State> {
	let state = await readState(env);
	// Only a finished pass gives way to a new one, and at most once per UTC day.
	if (!state || (state.done && state.day !== utcDay(now))) state = freshState(now);
	if (state.done) return state;

	const batch = Math.max(1, Math.min(Number(env.BATCH ?? 200), 500));
	const page = await env.SOURCE.list({ limit: batch, ...(state.cursor ? { cursor: state.cursor } : {}) });
	const copiedKeys: string[] = [];
	state.run += 1;
	for (const object of page.objects) {
		state.listed += 1;
		try {
			await copyOne(env, state, copiedKeys, object.key, object.etag);
		} catch (error) {
			state.errorCount += 1;
			if (state.errors.length < MAX_ERRORS) state.errors.push({ key: object.key, error: error instanceof Error ? error.message : String(error) });
		}
	}
	if (copiedKeys.length > 0) {
		// Unique per invocation (QA): if the state write after this fails, the next run reuses the
		// same run number, and a locked manifest key must never collide and wedge the pass.
		await env.BACKUP.put(`manifests/${state.day}/${String(state.run).padStart(5, "0")}-${now.getTime()}-${crypto.randomUUID().slice(0, 8)}.json`, JSON.stringify({ day: state.day, run: state.run, at: now.toISOString(), keys: copiedKeys }), { httpMetadata: { contentType: "application/json" } });
	}
	state.cursor = page.truncated ? page.cursor : null;
	if (!page.truncated) {
		state.done = true;
		const summary = { day: state.day, startedAt: state.startedAt, finishedAt: now.toISOString(), runs: state.run, listed: state.listed, copied: state.copied, versioned: state.versioned, bytes: state.bytes, errors: state.errorCount, firstErrors: state.errors.slice(0, 20) };
		await env.BACKUP.put(SUMMARY_KEY, JSON.stringify(summary), { httpMetadata: { contentType: "application/json" } });
	}
	await env.BACKUP.put(STATE_KEY, JSON.stringify(state), { httpMetadata: { contentType: "application/json" } });
	return state;
}

export default {
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(runCopy(env).then(() => undefined));
	},
};
