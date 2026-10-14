/**
 * picanteverde fork: app-icon badge from the page (Badging API). The service worker sets
 * it on each push; the open app keeps it in step as mail is read, moved or arrives.
 */
type BadgeNavigator = Navigator & { setAppBadge?: (count?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };

export async function setAppUnreadBadge(unread: number): Promise<void> {
	if (typeof navigator === "undefined" || !Number.isFinite(unread) || unread < 0) return;
	const nav = navigator as BadgeNavigator;
	try {
		if (unread === 0) await nav.clearAppBadge?.();
		else await nav.setAppBadge?.(Math.floor(unread));
	} catch {
		// Unsupported, or not allowed until notifications are granted.
	}
}

export function clearAppUnreadBadge(): void {
	void setAppUnreadBadge(0);
}
