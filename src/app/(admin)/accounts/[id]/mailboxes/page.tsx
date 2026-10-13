"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useLanguage } from "@/components/language-provider";
import { GrantsTable, type GrantEdit, type GrantRow } from "@/components/access/grants-table";
import type { ManagedAccount } from "../types";
import { fetchAccountGrants, fetchManagedAccount, saveAccountGrants } from "../utils";

/** picanteverde fork: which mailboxes this account may receive from and send as. */
export default function AccountMailboxesPage() {
	const { t } = useLanguage();
	const { id } = useParams<{ id: string }>();
	const [account, setAccount] = useState<ManagedAccount | null>(null);
	const [rows, setRows] = useState<GrantRow[]>([]);
	const [loading, setLoading] = useState(true);
	const [message, setMessage] = useState<string | null>(null);

	const load = useCallback(async () => {
		const [nextAccount, grants] = await Promise.all([fetchManagedAccount(id), fetchAccountGrants(id)]);
		setAccount(nextAccount);
		setRows(grants.map((grant) => ({
			key: grant.mailboxId,
			label: grant.address,
			sublabel: grant.displayName ?? undefined,
			note: grant.disabled ? t("access.mailboxDisabled") : undefined,
			receive: grant.receive,
			send: grant.send,
		})));
	}, [id, t]);

	useEffect(() => {
		void load()
			.catch((error) => setMessage(error instanceof Error ? error.message : t("access.loadFailed")))
			.finally(() => setLoading(false));
	}, [load, t]);

	async function save(changes: GrantEdit[]) {
		await saveAccountGrants(id, changes.map(({ key, receive, send }) => ({ mailboxId: key, receive, send })));
		await load();
	}

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl md:text-3xl font-medium text-neutral-900">{t("access.accountTitle")}</h1>
				<p className="mt-2 text-sm text-neutral-500">
					{t("access.accountDescription", { name: account?.name ?? t("account.password.thisAccount") })}
				</p>
			</div>
			<section className="rounded-3xl bg-white p-6">
				<GrantsTable rows={rows} loading={loading} itemNoun={t("access.mailboxNoun")} onSave={save} />
			</section>
			{message && <p role="alert" className="text-sm text-red-600">{message}</p>}
		</div>
	);
}
