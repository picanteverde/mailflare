import { WorkerEntrypoint } from "cloudflare:workers";
import { runCopy, type Env } from "./copy";

/*
 * picanteverde fork: entry module of the daily R2 copy (logic in ./copy.ts).
 *
 * Cloudflare never invoked this worker's own cron (staging, 2026-10-13: no events ever), so
 * another worker whose cron does fire calls `run()` over a service binding (QA option D). The
 * caller holds only that binding: it can start a run but cannot read or write either bucket.
 * There is still no fetch handler, no route, no workers.dev, and no delete anywhere.
 */
export class CopyEntrypoint extends WorkerEntrypoint<Env> {
	/** One step of today's pass; returns progress counts only, never object data. */
	async run() {
		const state = await runCopy(this.env);
		return { day: state.day, done: state.done, run: state.run, listed: state.listed, copied: state.copied, versioned: state.versioned, errors: state.errorCount };
	}
}

export default {
	// Not scheduled (wrangler.jsonc has no crons); kept only so `wrangler dev --test-scheduled` can
	// exercise a step locally.
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(runCopy(env).then(() => undefined));
	},
};
