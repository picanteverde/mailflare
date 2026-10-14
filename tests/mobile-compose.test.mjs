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
	assert.match(editor, /const formattingHidden = isMobile && !showFormatting;/);
	assert.match(editor, /<div className=\{cn\("contents", formattingHidden && "hidden"\)\}>/);
	assert.match(editor, /aria-label=\{t\("editor\.formatting"\)\}/);
});

test("phones: no long To placeholder, one Cc/Bcc toggle that opens both", () => {
	assert.match(form, /placeholder=\{isMobile \? undefined : t\("compose\.toPlaceholder"\)\}/);
	assert.match(form, /onClick=\{\(\) => \{ setShowCc\(true\); setShowBcc\(true\); \}\}/);
});

test("From options lead with the mailbox name", () => {
	assert.match(form, /mailbox\.displayName \? `\$\{mailbox\.displayName\} · \$\{address\}` : address/);
});
