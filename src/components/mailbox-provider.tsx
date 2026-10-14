"use client";

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";
import type { ReactNode } from "react";
import {
	clearMailboxesCache,
	GRANTS_CHANGED_EVENT,
	fetchMailboxOptions,
	isIdentityMailbox,
	SELECTED_MAILBOX_STORAGE_KEY,
} from "./mailbox-provider-utils";
import {
	AUTH_SESSION_CHANGED_EVENT,
	getClientSessionToken,
} from "@/lib/auth/client";
import { PROFILE_NAME_CHANGED_EVENT } from "@/lib/profile/name-client";
import { PROFILE_AVATAR_CHANGED_EVENT } from "@/lib/profile/avatar-client";
import type { ProfileNameChangedDetail } from "@/lib/profile/types";

export type MailboxOption = {
	id: string;
	domainId: string;
	localPart: string;
	hostname: string;
	displayName: string | null;
	signature?: string | null;
	autoReplyEnabled?: boolean;
	autoReplySubject?: string;
	autoReplyBody?: string;
	hasAvatar?: boolean;
	type?: "personal" | "shared";
	permission?: "read_only" | "send_as" | "send_on_behalf" | "full_access";
	isPrimary?: boolean;
	senderAddresses?: string[];
	/** picanteverde fork: the account's send grant; compose only offers mailboxes with it. */
	canSend?: boolean;
};

type MailboxContextValue = {
	selectedMailbox: MailboxOption | null;
	setSelectedMailbox: (mb: MailboxOption | null) => void;
	mailboxes: MailboxOption[];
	isLoading: boolean;
	/**
	 * picanteverde fork: "All inboxes". Lists and counts span every mailbox the account may
	 * read; selectedMailbox stays set (compose, settings and folders still need one).
	 */
	viewAll: boolean;
	setViewAll: (value: boolean) => void;
	/** The mailbox lists and counts are scoped to: null in "All inboxes". */
	listMailboxId: string | null;
};

const MailboxContext = createContext<MailboxContextValue | null>(null);
const VIEW_ALL_STORAGE_KEY = "mailflare:view-all-inboxes";

export function useSelectedMailbox() {
	const ctx = useContext(MailboxContext);
	if (!ctx) throw new Error("useSelectedMailbox must be used within MailboxProvider");
	return ctx;
}

export function MailboxProvider({ children }: { children: ReactNode }) {
	const [mailboxes, setMailboxes] = useState<MailboxOption[]>([]);
	const [selectedMailbox, setSelectedMailboxState] = useState<MailboxOption | null>(null);
	const [isLoading, setIsLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		let lastReload = 0;

		function load() {
			const sessionToken = getClientSessionToken();
			fetchMailboxOptions()
				.then((items) => {
					if (cancelled || sessionToken !== getClientSessionToken()) return;
					setMailboxes(items);

					const storedId = localStorage.getItem(SELECTED_MAILBOX_STORAGE_KEY);
					if (storedId) {
						const found = items.find((mb) => mb.id === storedId);
						if (found) {
							setSelectedMailboxState(found);
							return;
						}
					}

					// picanteverde fork: the stored mailbox may no longer be granted; fall back to a
					// granted one, or to none.
					const primary = items.find((mb) => mb.isPrimary) ?? items[0] ?? null;
					setSelectedMailboxState(primary);
					if (primary) localStorage.setItem(SELECTED_MAILBOX_STORAGE_KEY, primary.id);
					else localStorage.removeItem(SELECTED_MAILBOX_STORAGE_KEY);
				})
				.catch(() => {})
				.finally(() => {
					if (!cancelled && sessionToken === getClientSessionToken()) setIsLoading(false);
				});
		}

		// picanteverde fork: grants changed (realtime event, or a 403/404 on a mailbox request):
		// drop the cache and ask the server again, at most every few seconds.
		function reloadAfterGrantChange() {
			const now = Date.now();
			if (now - lastReload < 3_000) return;
			lastReload = now;
			clearMailboxesCache();
			load();
		}

		load();
		window.addEventListener(GRANTS_CHANGED_EVENT, reloadAfterGrantChange);
		return () => {
			cancelled = true;
			window.removeEventListener(GRANTS_CHANGED_EVENT, reloadAfterGrantChange);
		};
	}, []);

	useEffect(() => {
		function resetMailboxState() {
			setMailboxes([]);
			setSelectedMailboxState(null);
			setIsLoading(true);
		}

		window.addEventListener(AUTH_SESSION_CHANGED_EVENT, resetMailboxState);
		return () => window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, resetMailboxState);
	}, []);

	useEffect(() => {
		function updatePersonalMailboxNames(event: Event) {
			const { name } = (event as CustomEvent<ProfileNameChangedDetail>).detail;
			clearMailboxesCache();
			// Only the primary mailbox follows the profile name; the rest keep their own.
			setMailboxes((items) => items.map((mailbox) => (
				isIdentityMailbox(mailbox) ? { ...mailbox, displayName: name } : mailbox
			)));
			setSelectedMailboxState((mailbox) => (
				mailbox && isIdentityMailbox(mailbox) ? { ...mailbox, displayName: name } : mailbox
			));
		}

		window.addEventListener(PROFILE_NAME_CHANGED_EVENT, updatePersonalMailboxNames);
		return () => window.removeEventListener(PROFILE_NAME_CHANGED_EVENT, updatePersonalMailboxNames);
	}, []);

	useEffect(() => {
		function updatePersonalMailboxAvatars() {
			clearMailboxesCache();
			setMailboxes((items) => items.map((mailbox) => (
				isIdentityMailbox(mailbox) ? { ...mailbox, hasAvatar: true } : mailbox
			)));
			setSelectedMailboxState((mailbox) => (
				mailbox && isIdentityMailbox(mailbox) ? { ...mailbox, hasAvatar: true } : mailbox
			));
		}

		window.addEventListener(PROFILE_AVATAR_CHANGED_EVENT, updatePersonalMailboxAvatars);
		return () => window.removeEventListener(PROFILE_AVATAR_CHANGED_EVENT, updatePersonalMailboxAvatars);
	}, []);

	const [viewAll, setViewAllState] = useState(false);
	useEffect(() => {
		try {
			setViewAllState(localStorage.getItem(VIEW_ALL_STORAGE_KEY) === "1");
		} catch {
			// Storage can be unavailable; default to one mailbox.
		}
	}, []);
	const setViewAll = useCallback((value: boolean) => {
		setViewAllState(value);
		try {
			if (value) localStorage.setItem(VIEW_ALL_STORAGE_KEY, "1");
			else localStorage.removeItem(VIEW_ALL_STORAGE_KEY);
		} catch {
			// Not persisted; the choice still applies to this tab.
		}
	}, []);

	const setSelectedMailbox = useCallback((mb: MailboxOption | null) => {
		// Picking one mailbox leaves "All inboxes".
		setViewAll(false);
		setSelectedMailboxState((current) => (current?.id === mb?.id ? current : mb));
		if (mb) {
			setMailboxes((items) => items.map((item) => (item.id === mb.id && item !== mb ? mb : item)));
			localStorage.setItem(SELECTED_MAILBOX_STORAGE_KEY, mb.id);
		} else {
			localStorage.removeItem(SELECTED_MAILBOX_STORAGE_KEY);
		}
	}, [setViewAll]);

	// With a single mailbox there is nothing to combine.
	const effectiveViewAll = viewAll && mailboxes.length > 1;
	const listMailboxId = effectiveViewAll ? null : selectedMailbox?.id ?? null;

	return (
		<MailboxContext.Provider value={{ selectedMailbox, setSelectedMailbox, mailboxes, isLoading, viewAll: effectiveViewAll, setViewAll, listMailboxId }}>
			{children}
		</MailboxContext.Provider>
	);
}
