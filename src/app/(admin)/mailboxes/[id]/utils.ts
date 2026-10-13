import { authFetch } from "@/lib/auth/client";
import { clearMailboxesCache } from "@/components/mailbox-provider-utils";
import type { MailboxAliasesResponse, MailboxDetail, MailboxDetailResponse } from "./types";

export function getMailboxAddress(mailbox: Pick<MailboxDetail, "localPart" | "hostname">): string {
	return `${mailbox.localPart}@${mailbox.hostname}`;
}

export async function fetchMailbox(id: string): Promise<MailboxDetail> {
	const res = await authFetch(`/api/mailboxes/${id}`);
	const json = (await res.json()) as MailboxDetailResponse;

	if (!res.ok || !json.mailbox) {
		throw new Error(json.error ?? "Failed to load mailbox");
	}

	return json.mailbox;
}

export async function updateMailboxSettings(
	id: string,
	input: { displayName: string; useAllDomains: boolean },
): Promise<MailboxDetail> {
	const res = await authFetch(`/api/mailboxes/${id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const json = (await res.json()) as MailboxDetailResponse;

	if (!res.ok || !json.mailbox) {
		throw new Error(json.error ?? "Failed to update mailbox");
	}

	clearMailboxesCache();
	return json.mailbox;
}

/** picanteverde fork: every account with its receive/send grant on this mailbox. */
export type MailboxGrant = { userId: string; email: string; name: string; role: "admin" | "user"; disabled: boolean; receive: boolean; send: boolean };

export async function fetchMailboxGrants(id: string): Promise<MailboxGrant[]> {
	const res = await authFetch(`/api/mailboxes/${id}/access`);
	const json = (await res.json()) as { accounts?: MailboxGrant[]; error?: string };
	if (!res.ok) throw new Error(json.error ?? "Failed to load access");
	return json.accounts ?? [];
}

export async function saveMailboxGrants(id: string, grants: { userId: string; receive: boolean; send: boolean }[]): Promise<void> {
	const res = await authFetch(`/api/mailboxes/${id}/access`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ grants }),
	});
	const json = (await res.json()) as { error?: unknown };
	if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "Failed to save access");
}

export async function fetchMailboxAliases(id: string): Promise<MailboxAliasesResponse> {
	const res = await authFetch(`/api/mailboxes/${id}/aliases`);
	const json = (await res.json()) as MailboxAliasesResponse;
	if (!res.ok) throw new Error(json.error ?? "Failed to load aliases");
	return json;
}

export async function createMailboxAlias(
	id: string,
	input: { domainId: string; localPart: string },
): Promise<void> {
	const res = await authFetch(`/api/mailboxes/${id}/aliases`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const json = (await res.json()) as { error?: string };
	if (!res.ok) throw new Error(json.error ?? "Failed to add alias");

	clearMailboxesCache();
}

export async function deleteMailboxAlias(id: string, aliasId: string): Promise<void> {
	const res = await authFetch(`/api/mailboxes/${id}/aliases?aliasId=${encodeURIComponent(aliasId)}`, {
		method: "DELETE",
	});
	const json = (await res.json()) as { error?: string };
	if (!res.ok) throw new Error(json.error ?? "Failed to remove alias");

	clearMailboxesCache();
}

export async function deleteMailbox(id: string): Promise<void> {
	const res = await authFetch(`/api/mailboxes/${id}`, { method: "DELETE" });
	const json = (await res.json()) as { error?: string };
	if (!res.ok) throw new Error(json.error ?? "Failed to delete mailbox");

	clearMailboxesCache();
}
