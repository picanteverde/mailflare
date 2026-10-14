/** Pull distance (px, after damping) that triggers a refresh. */
export const PULL_THRESHOLD = 64;
export const MAX_PULL = 96;

/**
 * picanteverde fork: the pull-to-refresh gesture, free of React and the DOM so it can be
 * tested. A pull only counts while the list's own scroll container is at the very top,
 * checked at touchstart and on every move (dragging back up mid-list is plain scrolling).
 */
export function createPullController(options: {
	scrollTop: () => number;
	onPull: (distance: number) => void;
	onRefresh: () => void;
}) {
	let startY: number | null = null;
	let distance = 0;
	const atTop = () => options.scrollTop() <= 0;

	return {
		start(y: number, touches = 1) {
			if (touches !== 1 || !atTop()) {
				startY = null;
				return;
			}
			startY = y;
			distance = 0;
		},
		move(y: number) {
			if (startY === null) return;
			if (!atTop()) {
				startY = null;
				distance = 0;
				options.onPull(0);
				return;
			}
			const delta = y - startY;
			distance = delta > 0 ? Math.min(MAX_PULL, delta * 0.5) : 0;
			options.onPull(distance);
		},
		end() {
			if (startY === null) return;
			startY = null;
			const fire = distance >= PULL_THRESHOLD;
			distance = 0;
			options.onPull(0);
			if (fire) options.onRefresh();
		},
	};
}
