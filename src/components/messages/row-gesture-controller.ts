/**
 * picanteverde fork: list-row touch gestures without React or the DOM, so they can be tested
 * (QA mobile #31/#34). One controller per touch:
 * - the axis locks on the first INTENT_DISTANCE of movement; a vertical lock is plain
 *   scrolling, so no swipe and no long-press;
 * - touches that start within EDGE_GUARD px of either screen edge are ignored (iOS back/forward
 *   swipe);
 * - a horizontal drag past COMMIT_DISTANCE triggers the swipe for that side;
 * - holding still for LONG_PRESS_MS triggers a long-press (selection mode).
 */
export const INTENT_DISTANCE = 10;
export const COMMIT_DISTANCE = 88;
export const EDGE_GUARD = 20;
export const LONG_PRESS_MS = 500;

export type SwipeSide = "start" | "end";

export function createRowGestureController(options: {
	viewportWidth: () => number;
	canSwipe: (side: SwipeSide) => boolean;
	onOffset: (dx: number) => void;
	onSwipe: (side: SwipeSide) => void;
	onLongPress?: () => void;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}) {
	const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
	const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	let start: { x: number; y: number } | null = null;
	let axis: "x" | "y" | null = null;
	let dx = 0;
	let pressTimer: unknown = null;
	let suppressClick = false;

	function cancelPress() {
		if (pressTimer !== null) clearTimer(pressTimer);
		pressTimer = null;
	}

	return {
		/** True once if the last touch was a swipe or long-press, so its click must not open the message. */
		consumeClick() {
			const value = suppressClick;
			suppressClick = false;
			return value;
		},
		start(x: number, y: number) {
			cancelPress();
			start = null;
			axis = null;
			dx = 0;
			suppressClick = false;
			const width = options.viewportWidth();
			if (x < EDGE_GUARD || (width > 0 && x > width - EDGE_GUARD)) return;
			start = { x, y };
			if (options.onLongPress) {
				pressTimer = setTimer(() => {
					pressTimer = null;
					if (!start || axis) return;
					suppressClick = true;
					start = null;
					options.onLongPress?.();
				}, LONG_PRESS_MS);
			}
		},
		move(x: number, y: number) {
			if (!start) return;
			const mx = x - start.x;
			const my = y - start.y;
			if (!axis) {
				if (Math.abs(mx) < INTENT_DISTANCE && Math.abs(my) < INTENT_DISTANCE) return;
				cancelPress();
				axis = Math.abs(mx) > Math.abs(my) ? "x" : "y";
				if (axis === "y") {
					start = null;
					return;
				}
			}
			const side: SwipeSide = mx > 0 ? "start" : "end";
			dx = options.canSwipe(side) ? mx : 0;
			options.onOffset(dx);
		},
		end(cancelled = false) {
			cancelPress();
			if (!start) return;
			const wasSwipe = axis === "x";
			const distance = dx;
			start = null;
			axis = null;
			dx = 0;
			if (!wasSwipe) return;
			suppressClick = true;
			options.onOffset(0);
			if (cancelled) return;
			if (distance >= COMMIT_DISTANCE) options.onSwipe("start");
			else if (distance <= -COMMIT_DISTANCE) options.onSwipe("end");
		},
	};
}
