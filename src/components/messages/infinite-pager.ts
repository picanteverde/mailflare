/**
 * picanteverde fork: decides the next page for infinite scroll on phones (QA mobile #32).
 * Never asks for the same offset twice, stops at `total` or after an empty page, and starts
 * over when the list changes (folder, mailbox, search, filters).
 */
export function createInfinitePager() {
	const requested = new Set<number>();
	let exhausted = false;
	let inFlight = false;

	return {
		reset() {
			requested.clear();
			exhausted = false;
			inFlight = false;
		},
		/** The offset to load next, or null when nothing should be requested now. */
		next(loaded: number, total: number): number | null {
			if (inFlight || exhausted || loaded >= total || requested.has(loaded)) return null;
			requested.add(loaded);
			inFlight = true;
			return loaded;
		},
		/** Call when a page request settles; `received` is how many new messages it added. */
		done(received: number) {
			inFlight = false;
			if (received === 0) exhausted = true;
		},
		failed(offset: number) {
			inFlight = false;
			requested.delete(offset);
		},
	};
}
