import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// picanteverde fork: pull-to-refresh never blocks native scrolling and reuses the normal refresh.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hook = readFileSync(join(root, "src/hooks/use-pull-to-refresh.ts"), "utf8");

test("touch listeners are passive and never preventDefault", () => {
	for (const name of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
		assert.match(hook, new RegExp(`addEventListener\\("${name}", \\w+, \\{ passive: true \\}\\)`), name);
	}
	assert.doesNotMatch(hook, /preventDefault\(/);
});

test("a full pull clears the caches and fires the normal refresh event", () => {
	const end = hook.slice(hook.indexOf("function onEnd"), hook.indexOf("root.addEventListener"));
	assert.match(end, /distance >= PULL_THRESHOLD/);
	assert.match(end, /clearMessageListCache\(\);/);
	assert.match(end, /clearMessageCountsCache\(\);/);
	assert.match(end, /dispatchEvent\(new Event\("mailflare:messages-changed"\)\)/);
	assert.match(hook, /scroller\.scrollTop > 0/, "only from the top of the list");
});
