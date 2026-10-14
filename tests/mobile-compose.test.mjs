import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// picanteverde fork: phone composer details (QA mobile review #25-#29).
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const form = readFileSync(join(root, "src/components/compose/compose-form.tsx"), "utf8");
const editor = readFileSync(join(root, "src/components/compose/rich-text-editor.tsx"), "utf8");

test("formatting buttons fold behind Aa on phones; desktop keeps them", () => {
	assert.match(editor, /<div className=\{cn\("contents", !showFormatting && "max-md:hidden"\)\}>/);
	assert.match(editor, /h-11 min-w-11 rounded-md px-2\.5 text-sm font-semibold text-neutral-600 md:hidden/, "Aa is phone-only and 44pt, by CSS");
	assert.doesNotMatch(editor, /useIsMobile/, "no first-render flash from JS branching");
	assert.match(editor, /aria-label=\{t\("editor\.formatting"\)\}/);
});

test("phones: no long To placeholder, one Cc/Bcc toggle that opens both", () => {
	assert.match(form, /placeholder=\{isMobile \? undefined : t\("compose\.toPlaceholder"\)\}/);
	assert.match(form, /h-11 rounded px-1\.5 hover:text-neutral-800 md:hidden" onClick=\{\(\) => \{ setShowCc\(true\); setShowBcc\(true\); \}\}/);
	assert.equal((form.match(/hover:text-neutral-800 max-md:hidden"/g) ?? []).length, 2, "desktop Cc and Bcc are hidden on phones by CSS");
});

test("From options lead with the mailbox name", () => {
	assert.match(form, /mailbox\.displayName \? `\$\{mailbox\.displayName\} · \$\{address\}` : address/);
});
