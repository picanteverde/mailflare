import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// picanteverde fork: the assistant button only shows when a provider can answer (admins always see it).
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(root, "node_modules", "mailflare-agent-avail-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
await build({
	stdin: { contents: `export { isAgentProviderUsable } from "./src/lib/agent/provider.ts";`, resolveDir: root, sourcefile: "entry.ts" },
	outfile: join(scratch, "entry.mjs"), bundle: true, platform: "node", format: "esm", target: "node24",
	tsconfig: join(root, "tsconfig.json"), packages: "external", logLevel: "silent",
});
const { isAgentProviderUsable } = await import(pathToFileURL(join(scratch, "entry.mjs")).href);

test("cloudflare provider needs the AI binding", () => {
	const config = { provider: "cloudflare", baseUrl: "", apiKey: "", model: "m" };
	assert.equal(isAgentProviderUsable({}, config), false, "the default fallback without AI is unusable");
	assert.equal(isAgentProviderUsable({ AI: {} }, config), true);
});

test("compatible provider needs base URL, key and model", () => {
	assert.equal(isAgentProviderUsable({}, { provider: "compatible", baseUrl: "https://x", apiKey: "k", model: "m" }), true);
	assert.equal(isAgentProviderUsable({}, { provider: "compatible", baseUrl: "https://x", apiKey: "", model: "m" }), false);
	assert.equal(isAgentProviderUsable({}, { provider: "compatible", baseUrl: "", apiKey: "k", model: "m" }), false);
});
