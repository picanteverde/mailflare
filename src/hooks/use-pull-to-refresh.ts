"use client";

import { useEffect, useRef, useState } from "react";
import { clearMessageCountsCache, clearMessageListCache } from "./utils";

/** Pull distance (px, after damping) that triggers a refresh. */
export const PULL_THRESHOLD = 64;
const MAX_PULL = 96;

function scrollParent(node: HTMLElement | null): HTMLElement | null {
	for (let el = node?.parentElement ?? null; el; el = el.parentElement) {
		const style = getComputedStyle(el);
		if (/(auto|scroll)/.test(style.overflowY)) return el;
	}
	return null;
}

/**
 * picanteverde fork: pull-to-refresh for the phone list. The Home Screen app has no reload
 * button. Pulling down from the top past PULL_THRESHOLD clears the list/count caches and
 * fires the same "messages changed" refresh the realtime socket uses. Listeners are passive,
 * so native scrolling is never blocked.
 */
export function usePullToRefresh(enabled: boolean) {
	const ref = useRef<HTMLDivElement | null>(null);
	const [pull, setPull] = useState(0);
	const [refreshing, setRefreshing] = useState(false);

	useEffect(() => {
		const root = ref.current;
		if (!enabled || !root) return;
		const scroller = scrollParent(root);
		let startY: number | null = null;
		let distance = 0;

		function onStart(event: TouchEvent) {
			if (event.touches.length !== 1 || (scroller && scroller.scrollTop > 0)) return;
			startY = event.touches[0].clientY;
			distance = 0;
		}
		function onMove(event: TouchEvent) {
			if (startY === null) return;
			if (scroller && scroller.scrollTop > 0) {
				startY = null;
				setPull(0);
				return;
			}
			const delta = event.touches[0].clientY - startY;
			distance = delta > 0 ? Math.min(MAX_PULL, delta * 0.5) : 0;
			setPull(distance);
		}
		function onEnd() {
			if (startY === null) return;
			startY = null;
			if (distance >= PULL_THRESHOLD) {
				setRefreshing(true);
				clearMessageListCache();
				clearMessageCountsCache();
				window.dispatchEvent(new Event("mailflare:messages-changed"));
				window.setTimeout(() => setRefreshing(false), 700);
			}
			distance = 0;
			setPull(0);
		}
		root.addEventListener("touchstart", onStart, { passive: true });
		root.addEventListener("touchmove", onMove, { passive: true });
		root.addEventListener("touchend", onEnd, { passive: true });
		root.addEventListener("touchcancel", onEnd, { passive: true });
		return () => {
			root.removeEventListener("touchstart", onStart);
			root.removeEventListener("touchmove", onMove);
			root.removeEventListener("touchend", onEnd);
			root.removeEventListener("touchcancel", onEnd);
		};
	}, [enabled]);

	return { ref, pull, refreshing };
}
