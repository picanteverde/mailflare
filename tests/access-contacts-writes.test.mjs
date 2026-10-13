import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// picanteverde fork (QA, 8c review): contacts.mailbox_id stays nullable in SQLite, so every
// write path must set it. This fails if any insert into contacts (Drizzle or raw SQL) in src/
// does not name the mailbox, including ones arriving with an upstream sync.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = [];
const walk = (dir) => {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path);
		else if (/\.(ts|tsx)$/.test(name)) files.push(path);
	}
};
walk(root);

/** The text of the object literal passed to .values( after `from`, braces balanced. */
function valuesBlock(source, from) {
	const start = source.indexOf(".values(", from);
	const open = source.indexOf("{", start);
	let depth = 0;
	for (let index = open; index < source.length; index += 1) {
		if (source[index] === "{") depth += 1;
		if (source[index] === "}") depth -= 1;
		if (depth === 0) return source.slice(open, index + 1);
	}
	return "";
}

test("every insert into contacts sets the mailbox", () => {
	let checked = 0;
	for (const file of files) {
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(/\.insert\(contacts\)/g)) {
			checked += 1;
			assert.match(valuesBlock(source, match.index), /\bmailboxId\b/, `${file} inserts a contact without mailboxId`);
		}
		for (const match of source.matchAll(/INSERT INTO\s+\\?`?contacts\\?`?\s*\(([^)]*)\)/gi)) {
			checked += 1;
			assert.match(match[1], /mailbox_id/, `${file} inserts a contact without mailbox_id`);
		}
	}
	assert.ok(checked >= 5, `only ${checked} contact inserts found`);
});
