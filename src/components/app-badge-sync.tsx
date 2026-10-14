"use client";

import { useEffect } from "react";
import { useMessageCounts } from "@/hooks/use-message-counts";
import { setAppUnreadBadge } from "@/lib/push/badge-client";

/**
 * picanteverde fork: keeps the app-icon badge equal to unread inbox mail across every
 * mailbox this account may receive from (counts without a mailboxId are grant-scoped).
 * The counts hook refreshes on realtime revisions and local read/unread changes.
 */
export function AppBadgeSync() {
	const { counts, isLoading } = useMessageCounts(null, true);
	const unread = counts.folders.inbox.unread;

	useEffect(() => {
		if (isLoading) return;
		void setAppUnreadBadge(unread);
	}, [isLoading, unread]);

	return null;
}
