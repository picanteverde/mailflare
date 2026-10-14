import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// picanteverde fork: the per-mailbox number in the phone drawer uses the inbox rule, like the badge.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(root, "node_modules", "mailflare-mobile-counts-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/app/api/messages/counts/utils.ts")],
	outfile: join(scratch, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { buildMessageCounts } = await import(pathToFileURL(join(scratch, "entry.mjs")).href);

const row = (over) => ({ mailboxId: "s", folderId: null, direction: "inbound", status: "received", read: false, starred: false, snoozedUntil: null, total: 1, ...over });

test("inboxUnread counts only unread inbox mail; unread keeps every folder", () => {
	const counts = buildMessageCounts([
		row({}),
		row({ read: true }),
		row({ status: "archived" }),
		row({ status: "spam" }),
		row({ folderId: "f" }),
		row({ snoozedUntil: new Date(Date.now() + 3_600_000) }),
		row({ direction: "outbound", status: "sent" }),
	]);
	const mailbox = counts.mailboxes.find((m) => m.mailboxId === "s");
	assert.equal(mailbox.inboxUnread, 1);
	assert.equal(mailbox.inboxUnread, counts.folders.inbox.unread, "drawer and inbox counter agree");
	assert.ok(mailbox.unread > mailbox.inboxUnread);
});
