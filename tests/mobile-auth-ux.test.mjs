import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// picanteverde fork: QA mobile #5, #10, #11.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("every user-facing password field has the show/hide toggle", () => {
	for (const p of ["src/app/(auth)/login/login-client.tsx", "src/app/(auth)/register/register-client.tsx", "src/app/(auth)/reset-password/reset-password-client.tsx", "src/components/settings/change-password-form.tsx", "src/components/settings/mfa-settings.tsx", "src/app/(admin)/accounts/page.tsx", "src/app/(admin)/accounts/[id]/password/page.tsx"]) {
		const s = read(p);
		assert.doesNotMatch(s, /type="password"/, p);
		assert.match(s, /<PasswordInput\b/, p);
	}
	const input = read("src/components/ui/password-input.tsx");
	assert.match(input, /type=\{visible \? "text" : "password"\}/);
	assert.match(input, /t\("auth\.hidePassword"\) : t\("auth\.showPassword"\)/);
	assert.match(input, /type=\{visible \? "text" : "password"\} autoCapitalize="none" autoCorrect="off" spellCheck=\{false\}/, "no autocapitalize/autocorrect when shown");
});

test("2FA-off shows the required banner; recovery codes can be shared", () => {
	const mfa = read("src/components/settings/mfa-settings.tsx");
	assert.match(mfa, /\{!status\.enabled && \(\s*\n\s*<div role="status"[^>]*>\s*\n\s*\{t\("mfa\.requiredBanner"\)\}/);
	assert.match(mfa, /navigator\.share\(\{ text: codes\.join\("\\n"\) \}\)/);
});
