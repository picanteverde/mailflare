import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getAgentEnabled, getAgentProviderConfig, isAgentProviderUsable } from "@/lib/agent/provider";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
	// picanteverde fork: with no usable AI provider the assistant button is noise for users;
	// admins still see it, since the panel is where the provider is set up.
	const enabled = await getAgentEnabled(env)
		&& (user.role === "admin" || isAgentProviderUsable(env, await getAgentProviderConfig(env)));
	return Response.json({ enabled }, { headers: { "Cache-Control": "no-store" } });
}
