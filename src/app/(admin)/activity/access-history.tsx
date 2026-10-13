"use client";

import { useQuery } from "@tanstack/react-query";
import { useLanguage } from "@/components/language-provider";
import { authFetch } from "@/lib/auth/client";

type AccessEvent = {
	id: string;
	action: string;
	metadata: string | null;
	createdAt: string;
	actorEmail: string | null;
	targetEmail: string | null;
	mailboxLocalPart: string | null;
	mailboxHostname: string | null;
};

async function fetchAccessHistory(): Promise<AccessEvent[]> {
	const response = await authFetch("/api/audit-logs?kind=access&limit=200");
	const data = (await response.json()) as { auditLogs?: AccessEvent[]; error?: string };
	if (!response.ok) throw new Error(data.error ?? "Unable to load access history");
	return data.auditLogs ?? [];
}

function describe(event: AccessEvent, selfLabel: string): string {
	let metadata: Record<string, unknown> = {};
	try {
		metadata = event.metadata ? (JSON.parse(event.metadata) as Record<string, unknown>) : {};
	} catch {
		// Shown without details.
	}
	const flags = (value: unknown) => {
		const grant = value as { receive?: boolean; send?: boolean } | undefined;
		return grant?.send ? "receive + send" : grant?.receive ? "receive" : "none";
	};
	if (event.action === "grant.set" || event.action === "grant.revoke") {
		const next = event.action === "grant.revoke" ? "none" : flags(metadata);
		return `${flags(metadata.previous)} → ${next}${metadata.self ? ` (${selfLabel})` : ""}`;
	}
	if (event.action === "account.role_change") return `${String(metadata.from)} → ${String(metadata.to)}`;
	if (event.action === "account.update" && Array.isArray(metadata.fields)) return metadata.fields.join(", ");
	if (event.action === "session.revoke") return `${String(metadata.count ?? 0)} session(s)`;
	if (metadata.target_is_admin) return "admin account";
	return "";
}

/** picanteverde fork: who changed which account or grant, and when. Primary admin only (server-enforced). */
export function AccessHistory() {
	const { t } = useLanguage();
	const history = useQuery({ queryKey: ["activity", "access"], queryFn: fetchAccessHistory });
	return (
		<section className="space-y-3">
			<div>
				<h2 className="text-lg font-medium text-neutral-900">{t("access.auditTitle")}</h2>
				<p className="mt-1 text-sm text-neutral-500">{t("access.auditDescription")}</p>
			</div>
			<div className="overflow-x-auto rounded-3xl bg-white">
				<table className="w-full min-w-[720px] text-left text-sm">
					<thead className="border-b border-neutral-100 bg-neutral-50 text-xs font-semibold uppercase tracking-wide text-neutral-500">
						<tr>
							<th scope="col" className="px-5 py-3">{t("activity.col.activity")}</th>
							<th scope="col" className="px-5 py-3">{t("activity.col.user")}</th>
							<th scope="col" className="px-5 py-3">{t("access.accountNoun")} / {t("access.mailboxNoun")}</th>
							<th scope="col" className="px-5 py-3">{t("activity.col.time")}</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-neutral-100">
						{history.isLoading && <tr><td colSpan={4} className="px-5 py-4 text-neutral-500">{t("common.loading")}</td></tr>}
						{history.isError && <tr><td colSpan={4} className="px-5 py-4 text-red-600">{history.error instanceof Error ? history.error.message : t("access.loadFailed")}</td></tr>}
						{history.data?.length === 0 && <tr><td colSpan={4} className="px-5 py-4 text-neutral-500">{t("access.auditEmpty")}</td></tr>}
						{history.data?.map((event) => {
							const details = describe(event, t("access.auditSelf"));
							const mailbox = event.mailboxLocalPart ? `${event.mailboxLocalPart}@${event.mailboxHostname}` : null;
							return (
								<tr key={event.id} className={details.includes(t("access.auditSelf")) ? "bg-amber-50" : undefined}>
									<td className="px-5 py-3 align-top">
										<span className="font-medium text-neutral-900">{event.action}</span>
										{details && <span className="block text-xs text-neutral-500">{details}</span>}
									</td>
									<td className="px-5 py-3 align-top text-neutral-700">{event.actorEmail ?? "—"}</td>
									<td className="px-5 py-3 align-top text-neutral-700">
										{event.targetEmail && <span className="block">{event.targetEmail}</span>}
										{mailbox && <span className="block text-xs text-neutral-500">{mailbox}</span>}
										{!event.targetEmail && !mailbox && "—"}
									</td>
									<td className="px-5 py-3 align-top text-neutral-500">{new Date(event.createdAt).toLocaleString()}</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</section>
	);
}
