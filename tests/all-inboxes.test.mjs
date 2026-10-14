import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// picanteverde fork: "All inboxes" is left only by the explicit mailbox pickers, never by
// compose/draft/reply code that sets the sending mailbox, and destructive or per-mailbox
// controls are hidden in it.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("setSelectedMailbox does not leave All inboxes; the pickers do", () => {
	const provider = read("src/components/mailbox-provider.tsx");
	const body = provider.slice(provider.indexOf("const setSelectedMailbox = useCallback"), provider.indexOf("// With a single mailbox"));
	assert.doesNotMatch(body.replace(/\/\/.*$/gm, ""), /setViewAll\(/);
	for (const picker of ["src/components/mobile-mailbox-list.tsx", "src/components/mailbox-selector.tsx"]) {
		assert.match(read(picker), /setViewAll\(false\);\s*\n\s*setSelectedMailbox\(mailbox\)/, picker);
	}
});

test("All inboxes hides Empty folder and the per-mailbox custom folders", () => {
	assert.match(read("src/components/messages/message-folder-page.tsx"), /const permanentDeleteFolder = !viewAll && /);
	const nav = read("src/components/dashboard-nav.tsx");
	assert.match(nav, /!minimal && !viewAll && \(\s*\n\s*<NavSectionHeader label=\{t\("navigation\.folders"\)\}/);
	assert.match(nav, /!viewAll && \(minimal \|\| foldersSectionOpen\) && <ReorderableList/);
});

test("the avatar-menu list shows every mailbox with the current one checked (QA #13)", () => {
	const selector = read("src/components/mailbox-selector.tsx");
	assert.doesNotMatch(selector, /otherMailboxes/);
	assert.match(selector, /inboxesOpen && mailboxes\.map\(/);
	assert.match(selector, /current=\{!viewAll && mailbox\.id === selectedMailbox\?\.id\}/);
	assert.match(selector, /\{t\("account\.inboxes", \{ count: mailboxes\.length \}\)\}/);
});
