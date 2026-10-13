"use client";

import { mobilePrimaryActionClass } from "@/components/page-header-utils";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { authFetch } from "@/lib/auth/client";
import { ProgressiveAvatarImage } from "@/components/progressive-avatar-image";
import { getAvatarColorStyle } from "@/lib/avatar-colors";
import { List, ListRow } from "@/components/ui/list";
import { useCurrentUser } from "@/hooks/use-current-user";
import { defaultTranslator } from "@/lib/i18n/utils";
import type { Account, AccountResponse } from "./types";

async function fetchAccounts(): Promise<AccountResponse> {
	const response = await authFetch("/api/accounts");
	const data = (await response.json()) as AccountResponse;
	if (!response.ok) throw new Error(data.error ?? defaultTranslator("accounts.loadFailed"));
	return data;
}

export default function AccountsPage() {
	const { t } = useLanguage();
	const currentUser = useCurrentUser();
	// picanteverde fork: admin is all-or-nothing; accounts are logins without mailboxes and no seats.
	const canManage = currentUser?.role === "admin";
	const canChooseRole = !!currentUser?.isPrimaryAdmin;
	const [accounts, setAccounts] = useState<Account[]>([]);
	const [login, setLogin] = useState("");
	const [name, setName] = useState("");
	const [role, setRole] = useState<"admin" | "user">("user");
	const [password, setPassword] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const [message, setMessage] = useState<string | null>(null);

	async function loadAccounts() {
		const data = await fetchAccounts();
		setAccounts(data.accounts ?? []);
	}

	useEffect(() => {
		loadAccounts()
			.catch((error) => setMessage(error instanceof Error ? error.message : t("accounts.loadFailed")))
			.finally(() => setLoading(false));
	}, []);

	async function createAccount(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setSaving(true);
		setMessage(null);
		try {
			const response = await authFetch("/api/accounts", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ login, name: name.trim() || undefined, password, role }),
			});
			const data = (await response.json()) as AccountResponse;
			if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : t("accounts.checkDetails"));
			setLogin("");
			setName("");
			setPassword("");
			setRole("user");
			setCreateOpen(false);
			await loadAccounts();
		} catch (error) {
			setMessage(error instanceof Error ? error.message : t("accounts.createFailed"));
		} finally {
			setSaving(false);
		}
	}

	return <div className="space-y-6">
		<div className="flex items-center justify-between gap-4"><div><h1 className="text-2xl md:text-3xl font-medium text-neutral-900">{t("accounts.title")}</h1><p className="mt-2 text-sm text-neutral-500">{t("accounts.description")}</p></div>{canManage && <Button className={mobilePrimaryActionClass} onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />{t("accounts.new")}</Button>}</div>
		{message && !createOpen && <p role="alert" className="text-sm text-red-600">{message}</p>}
		<div className="relative"><List>
			{loading && <p className="text-sm text-neutral-500">{t("common.loading")}</p>}
			{accounts.map((account) => {
				const locked = !currentUser?.isPrimaryAdmin && account.role === "admin" && account.id !== currentUser?.id;
				const row = <>
					<span style={getAvatarColorStyle(account.email)} className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold duration-200">{account.name.charAt(0).toUpperCase()}{account.hasAvatar && <ProgressiveAvatarImage src={`/api/accounts/${account.id}/avatar`} alt="" className="absolute inset-0 h-full w-full object-cover" />}</span>
					<span className="min-w-0"><span className="flex items-center gap-2"><span className="truncate font-semibold text-neutral-900">{account.name}</span><span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${account.isPrimaryAdmin ? "bg-amber-100 text-amber-800" : "bg-neutral-100 text-neutral-600"}`}>{account.isPrimaryAdmin ? t("accounts.primaryAdmin") : t(account.role === "admin" ? "accounts.role.admin" : "accounts.role.user")}</span></span><span className="block truncate text-sm text-neutral-500">{account.email}{account.disabled ? ` · ${t("access.accountDisabled")}` : ""}</span></span>
				</>;
				if (locked) {
					return <ListRow key={account.id} aria-disabled="true" title={t("accounts.lockedAdmin")} className="cursor-not-allowed opacity-50">{row}</ListRow>;
				}
				return <ListRow key={account.id} asChild><Link href={`/accounts/${account.id}`}>{row}</Link></ListRow>;
			})}
		</List></div>
		<Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent className="max-h-[calc(100dvh-4rem)] w-[min(640px,calc(100vw-32px))] overflow-y-auto"><DialogHeader><DialogTitle>{t("accounts.addTitle")}</DialogTitle><DialogDescription>{t("accounts.addDescription")}</DialogDescription></DialogHeader><form onSubmit={createAccount}><fieldset disabled={saving} className="space-y-4">
			<div className="space-y-2"><Label htmlFor="account-login">{t("access.createLogin")}</Label><Input id="account-login" value={login} onChange={(event) => setLogin(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} aria-describedby="account-login-hint" required /><p id="account-login-hint" className="text-xs leading-5 text-neutral-500">{t("access.createLoginHint")}</p></div>
			<div className="space-y-2"><Label htmlFor="account-name">{t("access.createName")}</Label><Input id="account-name" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} /></div>
			<div className="space-y-2"><Label htmlFor="account-password">{t("auth.password")}</Label><Input id="account-password" type="password" minLength={12} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} aria-describedby="account-password-hint" required /><p id="account-password-hint" className="text-xs leading-5 text-neutral-500">{t("access.createPasswordHint")}</p></div>
			{canChooseRole && <div className="space-y-2"><Label htmlFor="account-role">{t("accounts.role")}</Label><Select id="account-role" value={role} onChange={(event) => setRole(event.target.value as "admin" | "user")} containerClassName="h-10 w-full bg-white px-0" className="px-3 text-sm"><option value="user">{t("accounts.roleUser")}</option><option value="admin">{t("accounts.roleAdmin")}</option></Select></div>}
			{message && <p role="alert" className="text-sm text-red-600">{message}</p>}<Button type="submit" disabled={saving || !login.trim() || password.length < 12}>{saving ? t("accounts.creating") : t("accounts.create")}</Button>
		</fieldset></form></DialogContent></Dialog>
	</div>;
}
