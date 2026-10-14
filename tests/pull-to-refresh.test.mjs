import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// picanteverde fork: pull-to-refresh fires only for a pull that starts and stays at the top of
// the list's own scroll container, never for a drag back up mid-list (QA on PR #10).
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(root, "node_modules", "mailflare-pull-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/hooks/pull-to-refresh-controller.ts")],
	outfile: join(scratch, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	logLevel: "silent",
});
const { createPullController, PULL_THRESHOLD } = await import(pathToFileURL(join(scratch, "entry.mjs")).href);

function setup(scrollTop) {
	const state = { scrollTop, refreshes: 0, pulls: [] };
	const controller = createPullController({
		scrollTop: () => state.scrollTop,
		onPull: (d) => state.pulls.push(d),
		onRefresh: () => state.refreshes++,
	});
	return { state, controller };
}
function drag(controller, from, to, steps = 10) {
	controller.start(from);
	for (let i = 1; i <= steps; i++) controller.move(from + ((to - from) * i) / steps);
	controller.end();
}

test("a long pull from the top refreshes once", () => {
	const { state, controller } = setup(0);
	drag(controller, 100, 100 + PULL_THRESHOLD * 2 + 10);
	assert.equal(state.refreshes, 1);
	assert.equal(state.pulls.at(-1), 0, "indicator resets");
});

test("scrolled 300px down, a downward drag scrolls and never refreshes", () => {
	const { state, controller } = setup(300);
	drag(controller, 100, 600);
	assert.equal(state.refreshes, 0);
	assert.ok(state.pulls.every((d) => d === 0));
});

test("a drag that started at the top stops counting once the list scrolls", () => {
	const { state, controller } = setup(0);
	controller.start(100);
	controller.move(150);
	state.scrollTop = 40;
	controller.move(400);
	controller.end();
	assert.equal(state.refreshes, 0);
});

test("a short pull, an upward drag, or two fingers do nothing", () => {
	const short = setup(0);
	drag(short.controller, 100, 100 + PULL_THRESHOLD);
	assert.equal(short.state.refreshes, 0);
	const up = setup(0);
	drag(up.controller, 400, 100);
	assert.equal(up.state.refreshes, 0);
	const two = setup(0);
	two.controller.start(100, 2);
	two.controller.move(400);
	two.controller.end();
	assert.equal(two.state.refreshes, 0);
});

test("listeners are passive on the list's scroll container; the spinner waits for the reload", () => {
	const hook = readFileSync(join(root, "src/hooks/use-pull-to-refresh.ts"), "utf8");
	for (const name of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
		assert.match(hook, new RegExp(`scroller\\.addEventListener\\("${name}", \\w+, \\{ passive: true \\}\\)`), name);
	}
	assert.doesNotMatch(hook, /preventDefault\(/);
	assert.match(hook, /MESSAGES_REFRESHED_EVENT/);
	const cleanup = hook.slice(hook.lastIndexOf("return () => {"));
	assert.match(cleanup, /if \(pendingFinish\) window\.removeEventListener\(MESSAGES_REFRESHED_EVENT, pendingFinish\);/, "no listener left after unmount");
	assert.match(readFileSync(join(root, "src/hooks/use-messages.ts"), "utf8"), /mailflare:messages-refreshed/);
	assert.match(readFileSync(join(root, "src/components/messages/message-folder-page.tsx"), "utf8"), /<div ref=\{pullScrollerRef\} className="min-h-0 flex-1 overflow-y-auto/);
});
