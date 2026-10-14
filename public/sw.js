const DEFAULT_NOTIFICATION = {
	title: "New email",
	body: "You have a new message",
	icon: "/icon-192.png",
	badge: "/icon-96.png",
	url: "/inbox",
};

// picanteverde fork: the app-icon badge (Badging API; iOS shows it for Home Screen web apps).
// The push carries only the account's unread total; 0 clears the badge.
async function setUnreadBadge(unread) {
	if (typeof unread !== "number" || !Number.isFinite(unread) || unread < 0) return;
	try {
		if (unread === 0) await self.navigator.clearAppBadge?.();
		else await self.navigator.setAppBadge?.(Math.floor(unread));
	} catch {
		// Badging unsupported or not permitted: the notification still shows.
	}
}

self.addEventListener("push", (event) => {
	event.waitUntil(
		(async () => {
			let payload = DEFAULT_NOTIFICATION;
			try {
				payload = { ...DEFAULT_NOTIFICATION, ...(event.data?.json() ?? {}) };
			} catch {
				// Keep the generic notification if a provider delivers an empty or malformed payload.
			}
			await setUnreadBadge(payload.unread);

			const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			if (windows.some((client) => client.visibilityState === "visible")) return;

			await self.registration.showNotification(payload.title, {
				body: payload.body,
				icon: payload.icon,
				badge: payload.badge,
				tag: payload.tag,
				data: { url: payload.url },
			});
		})(),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const target = new URL(event.notification.data?.url || "/inbox", self.location.origin).href;
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			for (const client of windows) {
				if (client.url.startsWith(self.location.origin)) {
					await client.focus();
					await client.navigate(target);
					return;
				}
			}
			await self.clients.openWindow(target);
		})(),
	);
});
