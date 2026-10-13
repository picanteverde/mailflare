"use client";

import { useEffect, useMemo, useState } from "react";
import { Save } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

/*
 * picanteverde fork: one table for both sides of a grant (an account's mailboxes, a
 * mailbox's accounts). Edits are local until Save, which sends only the changed rows in one
 * request; the server re-checks admin, applies them atomically and audits each pair. The
 * table never decides access itself: after saving it reloads what the server stored.
 */

export type GrantRow = {
	key: string;
	label: string;
	sublabel?: string;
	note?: string;
	receive: boolean;
	send: boolean;
};

export type GrantEdit = { key: string; receive: boolean; send: boolean };

export function GrantsTable({
	rows,
	loading,
	itemNoun,
	onSave,
}: {
	rows: GrantRow[];
	loading?: boolean;
	itemNoun: string;
	onSave: (changes: GrantEdit[]) => Promise<void>;
}) {
	const { t } = useLanguage();
	const [draft, setDraft] = useState<Record<string, { receive: boolean; send: boolean }>>({});
	const [filter, setFilter] = useState("");
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

	useEffect(() => {
		setDraft(Object.fromEntries(rows.map((row) => [row.key, { receive: row.receive, send: row.send }])));
	}, [rows]);

	const visible = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		return needle ? rows.filter((row) => `${row.label} ${row.sublabel ?? ""}`.toLowerCase().includes(needle)) : rows;
	}, [rows, filter]);

	const changes = useMemo<GrantEdit[]>(() => rows.flatMap((row) => {
		const next = draft[row.key];
		return next && (next.receive !== row.receive || next.send !== row.send) ? [{ key: row.key, ...next }] : [];
	}), [rows, draft]);

	// Send needs receive: turning receive off also turns send off; turning send on also turns
	// receive on. Each switch states its own intent, so neither ever undoes the other.
	function toggleReceive(key: string, current: { receive: boolean; send: boolean }, receive: boolean) {
		setMessage(null);
		setDraft((draftNow) => ({ ...draftNow, [key]: { receive, send: receive ? current.send : false } }));
	}

	function toggleSend(key: string, current: { receive: boolean; send: boolean }, send: boolean) {
		setMessage(null);
		setDraft((draftNow) => ({ ...draftNow, [key]: { receive: send ? true : current.receive, send } }));
	}

	function setAllVisible(value: { receive: boolean; send: boolean }) {
		setMessage(null);
		setDraft((current) => ({ ...current, ...Object.fromEntries(visible.map((row) => [row.key, value])) }));
	}

	async function save() {
		setSaving(true);
		setMessage(null);
		try {
			await onSave(changes);
			setMessage({ tone: "ok", text: t("access.saved", { count: changes.length }) });
		} catch (error) {
			setMessage({ tone: "error", text: error instanceof Error ? error.message : t("access.saveFailed") });
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center gap-2">
				<Input
					aria-label={t("access.filter", { noun: itemNoun })}
					placeholder={t("access.filter", { noun: itemNoun })}
					value={filter}
					onChange={(event) => setFilter(event.target.value)}
					className="min-w-0 flex-1 basis-48"
				/>
				<Button type="button" variant="outline" size="sm" disabled={saving || visible.length === 0} onClick={() => setAllVisible({ receive: true, send: false })}>
					{t("access.receiveAll")}
				</Button>
				<Button type="button" variant="outline" size="sm" disabled={saving || visible.length === 0} onClick={() => setAllVisible({ receive: false, send: false })}>
					{t("access.clearAll")}
				</Button>
			</div>
			<div className="overflow-hidden rounded-2xl border border-neutral-200">
				<table className="w-full table-fixed text-sm">
					<caption className="sr-only">{t("access.caption", { noun: itemNoun })}</caption>
					<thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
						<tr>
							<th scope="col" className="px-3 py-3 font-medium sm:px-4">{itemNoun}</th>
							<th scope="col" className="w-[4.75rem] px-1 py-3 text-center font-medium sm:w-24">{t("access.receive")}</th>
							<th scope="col" className="w-[4.75rem] px-1 py-3 text-center font-medium sm:w-24">{t("access.send")}</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-neutral-100">
						{loading && <tr><td colSpan={3} className="px-4 py-6 text-neutral-500">{t("common.loading")}</td></tr>}
						{!loading && visible.length === 0 && <tr><td colSpan={3} className="px-4 py-6 text-neutral-500">{t("access.empty", { noun: itemNoun })}</td></tr>}
						{visible.map((row) => {
							const value = draft[row.key] ?? { receive: row.receive, send: row.send };
							const changed = value.receive !== row.receive || value.send !== row.send;
							return (
								<tr key={row.key} className={changed ? "bg-amber-50" : undefined}>
									<th scope="row" className="px-3 py-3 text-left font-normal sm:px-4">
										<span className="block truncate font-medium text-neutral-900">{row.label}</span>
										{row.sublabel && <span className="block truncate text-xs text-neutral-500">{row.sublabel}</span>}
										{row.note && <span className="mt-0.5 inline-block rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">{row.note}</span>}
									</th>
									<td className="px-1 py-3 text-center">
										<Switch
											checked={value.receive}
											disabled={saving}
											aria-label={t("access.receiveFor", { name: row.label })}
											onCheckedChange={(receive) => toggleReceive(row.key, value, receive)}
										/>
									</td>
									<td className="px-1 py-3 text-center">
										<Switch
											checked={value.send}
											disabled={saving}
											aria-label={t("access.sendFor", { name: row.label })}
											onCheckedChange={(send) => toggleSend(row.key, value, send)}
										/>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
			<div className="flex flex-wrap items-center gap-3">
				<Button type="button" disabled={saving || changes.length === 0} onClick={() => void save()}>
					<Save className="h-4 w-4" />
					{saving ? t("common.saving") : t("access.save", { count: changes.length })}
				</Button>
				{changes.length > 0 && !saving && (
					<Button type="button" variant="ghost" onClick={() => setDraft(Object.fromEntries(rows.map((row) => [row.key, { receive: row.receive, send: row.send }])))}>
						{t("access.discard")}
					</Button>
				)}
				{message && <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "text-sm text-red-600" : "text-sm text-green-700"}>{message.text}</p>}
			</div>
			<p className="text-xs leading-5 text-neutral-500">{t("access.hint")}</p>
		</div>
	);
}
