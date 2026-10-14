"use client";

import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { useMessageCounts } from "@/hooks/use-message-counts";
import { useSelectedMailbox } from "./mailbox-provider";
import { useSidebar } from "./sidebar-state";

/**
 * picanteverde fork: on phones the mailbox switcher was buried in the avatar menu. The drawer
 * lists every mailbox this account may read, with its unread count, above the folders.
 */
export function MobileMailboxList() {
	const router = useRouter();
	const { mobile, closeMobile } = useSidebar();
	const { mailboxes, selectedMailbox, setSelectedMailbox } = useSelectedMailbox();
	const { counts } = useMessageCounts(null, mobile && mailboxes.length > 1);
	if (!mobile || mailboxes.length < 2) return null;
	const unreadById = new Map(counts.mailboxes.map((count) => [count.mailboxId, count.inboxUnread ?? 0]));

	return (
		<div className="mb-2 border-b border-neutral-200/70 px-3 pb-2">
			{mailboxes.map((mailbox) => {
				const active = mailbox.id === selectedMailbox?.id;
				const unread = unreadById.get(mailbox.id) ?? 0;
				const address = `${mailbox.localPart}@${mailbox.hostname}`;
				return (
					<button
						key={mailbox.id}
						type="button"
						aria-current={active || undefined}
						onClick={() => {
							setSelectedMailbox(mailbox);
							closeMobile();
							router.push("/inbox");
						}}
						className={cn(
							"flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left",
							active ? "bg-blue-100 text-blue-950" : "text-neutral-700 active:bg-neutral-200/60",
						)}
					>
						<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-sm font-semibold uppercase text-neutral-700">
							{(mailbox.displayName || mailbox.localPart).slice(0, 1)}
						</span>
						<span className="min-w-0 flex-1">
							<span className={cn("block truncate text-base", active && "font-semibold")}>{mailbox.displayName || mailbox.localPart}</span>
							<span className="block truncate text-xs text-neutral-500">{address}</span>
						</span>
						{unread > 0 && <span className="text-sm font-semibold">{unread > 99 ? "99+" : unread}</span>}
					</button>
				);
			})}
		</div>
	);
}
