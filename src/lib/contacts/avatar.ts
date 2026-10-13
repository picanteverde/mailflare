/** picanteverde fork: scoped by mailbox, like the contact itself. */
export function contactAvatarKeyFor(mailboxId: string, email: string): string {
	return `contact-avatars/${mailboxId}/${encodeURIComponent(email.trim().toLowerCase())}`;
}
