/**
 * picanteverde fork: decides the next page for infinite scroll on phones (QA mobile #32).
 * Never asks for the same offset twice within a generation, keeps at most one request in
 * flight (a reset does not clear it, so pages never overlap), and stops at `total` or after
 * an empty page. reset() starts a new generation: results from an older one are ignored.
 */
export function createInfinitePager() {
	const requested = new Set<number>();
	let exhausted = false;
	let inFlight = false;
	let generation = 0;

	return {
		generation: () => generation,
		reset() {
			generation++;
			requested.clear();
			exhausted = false;
		},
		/** The offset to load next, or null when nothing should be requested now. */
		next(loaded: number, total: number): number | null {
			if (inFlight || exhausted || loaded >= total || requested.has(loaded)) return null;
			requested.add(loaded);
			inFlight = true;
			return loaded;
		},
		/** A request from generation `gen` settled with `received` new messages. */
		done(received: number, gen: number) {
			inFlight = false;
			if (gen === generation && received === 0) exhausted = true;
		},
		failed(offset: number, gen: number) {
			inFlight = false;
			if (gen === generation) requested.delete(offset);
		},
	};
}

/** picanteverde fork: an action's effect on rows already on screen (appended pages). */
export function applyRowAction<T extends { id: string; read: boolean; threadUnread?: number }>(rows: T[], ids: string[], action: string): T[] {
	const set = new Set(ids);
	if (action === "read" || action === "unread") {
		const read = action === "read";
		return rows.map((row) => (set.has(row.id) ? { ...row, read, ...(read ? { threadUnread: 0 } : {}) } : row));
	}
	// Every other action (archive, unarchive, trash, spam, inbox, folder, delete) moves the
	// message out of the list being viewed.
	return rows.filter((row) => !set.has(row.id));
}
