import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// picanteverde fork: QA mobile #31 (long-press), #32 (infinite scroll), #34 (swipe) with QA's conditions.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(root, "node_modules", "mailflare-gestures-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `export * from "./src/components/messages/row-gesture-controller.ts"; export { applyRowAction, createInfinitePager } from "./src/components/messages/infinite-pager.ts"; export { getStatusForBulkAction, isAllowedBulkMessageAction } from "./src/app/api/messages/bulk/utils.ts";`,
		resolveDir: root,
		sourcefile: "entry.ts",
	},
	outfile: join(scratch, "entry.mjs"), bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent",
});
const g = await import(pathToFileURL(join(scratch, "entry.mjs")).href);

function rig({ width = 393, start = true, end = true } = {}) {
	const timers = [];
	const state = { swipes: [], longPress: 0, offsets: [] };
	const c = g.createRowGestureController({
		viewportWidth: () => width,
		canSwipe: (side) => (side === "start" ? start : end),
		onOffset: (dx) => state.offsets.push(dx),
		onSwipe: (side) => state.swipes.push(side),
		onLongPress: () => state.longPress++,
		setTimer: (fn) => { timers.push(fn); return timers.length - 1; },
		clearTimer: (h) => { timers[h] = null; },
	});
	return { c, state, fireTimers: () => timers.forEach((fn) => fn && fn()) };
}

test("a vertical scroll never swipes or long-presses (axis locks on the first move)", () => {
	const { c, state, fireTimers } = rig();
	c.start(200, 300);
	c.move(204, 320);
	c.move(260, 400); // turns sideways after locking vertical
	fireTimers();
	c.end();
	assert.deepEqual(state.swipes, []);
	assert.equal(state.longPress, 0);
	assert.equal(c.consumeClick(), false);
});

test("a horizontal drag past the commit distance swipes the matching side, and eats the click", () => {
	const left = rig();
	left.c.start(300, 300);
	left.c.move(300 - g.COMMIT_DISTANCE - 5, 302);
	left.c.end();
	assert.deepEqual(left.state.swipes, ["end"]);
	assert.equal(left.c.consumeClick(), true);
	const right = rig();
	right.c.start(100, 300);
	right.c.move(100 + g.COMMIT_DISTANCE + 5, 298);
	right.c.end();
	assert.deepEqual(right.state.swipes, ["start"]);
	const short = rig();
	short.c.start(200, 300);
	short.c.move(200 - 40, 300);
	short.c.end();
	assert.deepEqual(short.state.swipes, []);
});

test("touches starting at either screen edge are ignored (iOS back/forward swipe)", () => {
	const { c, state, fireTimers } = rig();
	c.start(g.EDGE_GUARD - 5, 300);
	c.move(g.EDGE_GUARD + 200, 300);
	fireTimers();
	c.end();
	c.start(393 - 5, 300);
	c.move(100, 300);
	c.end();
	assert.deepEqual(state.swipes, []);
	assert.equal(state.longPress, 0);
});

test("long-press fires only when the finger stays put, and eats the click", () => {
	const still = rig();
	still.c.start(200, 300);
	still.c.move(203, 302);
	still.fireTimers();
	still.c.end();
	assert.equal(still.state.longPress, 1);
	assert.equal(still.c.consumeClick(), true);
	const moved = rig();
	moved.c.start(200, 300);
	moved.c.move(200, 340);
	moved.fireTimers();
	moved.c.end();
	assert.equal(moved.state.longPress, 0);
});

test("rows without a swipe action do not move", () => {
	const { c, state } = rig({ start: false, end: false });
	c.start(300, 300);
	c.move(100, 300);
	c.end();
	assert.deepEqual(state.swipes, []);
	assert.ok(state.offsets.every((dx) => dx === 0));
});

test("infinite pager: never the same offset twice, one request at a time, stops at the end", () => {
	const p = g.createInfinitePager();
	let gen = p.generation();
	assert.equal(p.next(25, 60), 25);
	assert.equal(p.next(25, 60), null, "in flight");
	p.done(25, gen);
	assert.equal(p.next(25, 60), null, "same offset again");
	assert.equal(p.next(50, 60), 50);
	p.done(10, gen);
	assert.equal(p.next(60, 60), null, "end of list");
	const empty = g.createInfinitePager();
	assert.equal(empty.next(25, 100), 25);
	empty.done(0, empty.generation());
	assert.equal(empty.next(30, 100), null, "an empty page stops it");
	const retry = g.createInfinitePager();
	assert.equal(retry.next(25, 100), 25);
	retry.failed(25, retry.generation());
	assert.equal(retry.next(25, 100), 25, "a failed page can be retried");
});

test("pager reset keeps the in-flight request, so pages never overlap; stale results don't stop it (QA on #16)", () => {
	const p = g.createInfinitePager();
	const oldGen = p.generation();
	assert.equal(p.next(25, 100), 25);
	p.reset();
	assert.notEqual(p.generation(), oldGen);
	assert.equal(p.next(25, 100), null, "still one request in flight after reset");
	p.done(0, oldGen); // the stale request settles with nothing new
	assert.equal(p.next(25, 100), 25, "a stale empty result does not mark the list exhausted");
});

test("an action on an appended row updates what is shown (QA blocker on #16)", () => {
	const rows = [{ id: "a", read: false, threadUnread: 2 }, { id: "b", read: false }, { id: "c", read: true }];
	assert.deepEqual(g.applyRowAction(rows, ["b"], "archive").map((r) => r.id), ["a", "c"]);
	assert.deepEqual(g.applyRowAction(rows, ["a", "c"], "trash").map((r) => r.id), ["b"]);
	const read = g.applyRowAction(rows, ["a"], "read");
	assert.equal(read[0].read, true);
	assert.equal(read[0].threadUnread, 0);
	assert.equal(g.applyRowAction(rows, ["c"], "unread")[2].read, false);
	assert.strictEqual(g.applyRowAction(rows, ["zzz"], "read")[1], rows[1], "untouched rows keep identity");
});

test("unarchive restores archived mail to received and is an allowed bulk action", () => {
	assert.equal(g.isAllowedBulkMessageAction("unarchive"), true);
	assert.equal(g.getStatusForBulkAction("unarchive"), "received");
	const route = readFileSync(join(root, "src/app/api/messages/bulk/route.ts"), "utf8");
	assert.match(route, /if \(payload\.action === "unarchive" && message\.status !== "archived"\) continue;/);
	assert.match(route, /\(payload\.action === "inbox" \? \{ snoozedUntil: null \} : \{\}\)/, "only inbox clears snooze");
});

test("wiring: archive can be undone; checkboxes stay reachable without gestures", () => {
	const page = readFileSync(join(root, "src/components/messages/message-folder-page.tsx"), "utf8");
	assert.match(page, /if \(action === "archive"\) showUndo\(ids\);/);
	assert.match(page, /await runBulkMessageAction\(ids, "unarchive", false\);/);
	assert.match(page, /patchMorePages\(ids, action\);/);
	assert.match(page, /patchMorePages\(bulkIds, action\);/);
	assert.match(page, /if \(gen === pager\.generation\(\)\) setMorePages\(data\.messages \?\? \[\]\);/, "refreshed first page reloads the appended range");
	assert.match(page, /\[isMobile, loadMore, pullScrollerRef, morePages\.length\]/, "re-observe after each append");
	assert.match(page, /!selectionMode && "max-md:sr-only"/, "visually hidden, still accessible");
	assert.match(page, /onLongPress=\{\(\) => onSelectedChange\(message\.id, true\)\}/);
	assert.match(page, /isMobile && <div ref=\{sentinelRef\}/);
});
