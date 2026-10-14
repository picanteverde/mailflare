"use client";

import { useEffect, useRef, useState } from "react";
import { clearMessageCountsCache, clearMessageListCache } from "./utils";
import { createPullController } from "./pull-to-refresh-controller";

export { PULL_THRESHOLD } from "./pull-to-refresh-controller";

/** Fired by useMessages when a forced list reload has finished. */
export const MESSAGES_REFRESHED_EVENT = "mailflare:messages-refreshed";
const MIN_SPIN_MS = 700;
const MAX_SPIN_MS = 10_000;

/**
 * picanteverde fork: pull-to-refresh for the phone list (the Home Screen app has no reload
 * button). `scrollerRef` must be the list's own scroll container. Listeners are passive, so
 * native scrolling is never blocked. The spinner stays until the reload has finished (at
 * least MIN_SPIN_MS, at most MAX_SPIN_MS).
 */
export function usePullToRefresh(enabled: boolean) {
	const scrollerRef = useRef<HTMLDivElement | null>(null);
	const [pull, setPull] = useState(0);
	const [refreshing, setRefreshing] = useState(false);

	useEffect(() => {
		const scroller = scrollerRef.current;
		if (!enabled || !scroller) return;
		let doneTimer: number | null = null;
		let maxTimer: number | null = null;

		const controller = createPullController({
			scrollTop: () => scroller.scrollTop,
			onPull: setPull,
			onRefresh: () => {
				const startedAt = Date.now();
				setRefreshing(true);
				const finish = () => {
					window.removeEventListener(MESSAGES_REFRESHED_EVENT, finish);
					if (maxTimer) window.clearTimeout(maxTimer);
					doneTimer = window.setTimeout(() => setRefreshing(false), Math.max(0, MIN_SPIN_MS - (Date.now() - startedAt)));
				};
				window.addEventListener(MESSAGES_REFRESHED_EVENT, finish);
				maxTimer = window.setTimeout(finish, MAX_SPIN_MS);
				clearMessageListCache();
				clearMessageCountsCache();
				window.dispatchEvent(new Event("mailflare:messages-changed"));
			},
		});
		const onStart = (event: TouchEvent) => controller.start(event.touches[0]?.clientY ?? 0, event.touches.length);
		const onMove = (event: TouchEvent) => controller.move(event.touches[0]?.clientY ?? 0);
		const onEnd = () => controller.end();
		scroller.addEventListener("touchstart", onStart, { passive: true });
		scroller.addEventListener("touchmove", onMove, { passive: true });
		scroller.addEventListener("touchend", onEnd, { passive: true });
		scroller.addEventListener("touchcancel", onEnd, { passive: true });
		return () => {
			scroller.removeEventListener("touchstart", onStart);
			scroller.removeEventListener("touchmove", onMove);
			scroller.removeEventListener("touchend", onEnd);
			scroller.removeEventListener("touchcancel", onEnd);
			if (doneTimer) window.clearTimeout(doneTimer);
			if (maxTimer) window.clearTimeout(maxTimer);
		};
	}, [enabled]);

	return { scrollerRef, pull, refreshing };
}
