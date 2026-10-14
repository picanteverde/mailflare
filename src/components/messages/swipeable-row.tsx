"use client";

import clsx from "clsx";
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { COMMIT_DISTANCE, createRowGestureController, type SwipeSide } from "./row-gesture-controller";

type SwipeAction = {
	label: string;
	icon: LucideIcon;
	className: string;
	onTrigger: () => void;
};

type SwipeableRowProps = {
	children: ReactNode;
	// Revealed when dragging left to right.
	startAction?: SwipeAction | null;
	// Revealed when dragging right to left.
	endAction?: SwipeAction | null;
	/** picanteverde fork: hold to select (QA mobile #31). */
	onLongPress?: () => void;
	disabled?: boolean;
	role?: string;
};

// Touch-only gestures; vertical scrolling stays with the browser via touch-action: pan-y.
// The decisions live in row-gesture-controller.ts (axis lock, edge guard, long-press).
export function SwipeableRow({ children, startAction, endAction, onLongPress, disabled, role }: SwipeableRowProps) {
	const [offset, setOffset] = useState(0);
	const [dragging, setDragging] = useState(false);
	const pointerId = useRef<number | null>(null);
	const actions = useRef({ startAction, endAction, onLongPress });
	actions.current = { startAction, endAction, onLongPress };
	const controller = useRef<ReturnType<typeof createRowGestureController> | null>(null);
	if (!controller.current) {
		controller.current = createRowGestureController({
			viewportWidth: () => (typeof window === "undefined" ? 0 : window.innerWidth),
			canSwipe: (side: SwipeSide) => !!(side === "start" ? actions.current.startAction : actions.current.endAction),
			onOffset: (dx) => {
				setDragging(dx !== 0);
				setOffset(dx);
			},
			onSwipe: (side) => (side === "start" ? actions.current.startAction : actions.current.endAction)?.onTrigger(),
			onLongPress: () => actions.current.onLongPress?.(),
		});
	}
	useEffect(() => () => controller.current?.end(true), []);

	function onPointerDown(event: PointerEvent<HTMLDivElement>) {
		if (disabled || event.pointerType === "mouse") return;
		pointerId.current = event.pointerId;
		controller.current!.start(event.clientX, event.clientY);
	}
	function onPointerMove(event: PointerEvent<HTMLDivElement>) {
		if (pointerId.current !== event.pointerId) return;
		controller.current!.move(event.clientX, event.clientY);
	}
	function finish(event: PointerEvent<HTMLDivElement>) {
		if (pointerId.current !== event.pointerId) return;
		pointerId.current = null;
		controller.current!.end(event.type === "pointercancel");
		setDragging(false);
	}

	const action = offset > 0 ? startAction : offset < 0 ? endAction : null;
	const Icon = action?.icon;
	const armed = Math.abs(offset) >= COMMIT_DISTANCE;

	return (
		<div role={role} className="relative overflow-hidden">
			{action && Icon && (
				<div
					aria-hidden="true"
					className={clsx("absolute inset-0 flex items-center px-6 text-white", offset > 0 ? "justify-start" : "justify-end", action.className)}
				>
					<span className={clsx("flex items-center gap-2 text-sm font-medium transition-transform", armed && "scale-110")}>
						<Icon className="h-5 w-5" />
						{action.label}
					</span>
				</div>
			)}
			<div
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={finish}
				onPointerCancel={finish}
				onContextMenu={(event) => {
					// A long-press on iOS/Android would otherwise also open the link preview menu.
					if (onLongPress) event.preventDefault();
				}}
				onClickCapture={(event) => {
					if (!controller.current?.consumeClick()) return;
					event.preventDefault();
					event.stopPropagation();
				}}
				className={clsx("relative bg-white", !dragging && "transition-transform duration-200 ease-out motion-reduce:transition-none")}
				style={{ transform: offset ? `translateX(${offset}px)` : undefined, touchAction: "pan-y", WebkitTouchCallout: onLongPress ? "none" : undefined }}
			>
				{children}
			</div>
		</div>
	);
}
