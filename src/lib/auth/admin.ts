import type { SessionUser } from "./types";

export function isAdmin(user: Pick<SessionUser, "role">): boolean {
	return user.role === "admin";
}

export function assertAdmin(user: Pick<SessionUser, "role">): void {
	if (!isAdmin(user)) {
		throw new Error("Forbidden");
	}
}

/**
 * The primary admin is the single account created during setup. Only it can
 * manage other admins and reach owner-only administration pages.
 */
export function isPrimaryAdmin(
	user: Pick<SessionUser, "role" | "isPrimaryAdmin">,
): boolean {
	return user.role === "admin" && user.isPrimaryAdmin;
}

export function assertPrimaryAdmin(
	user: Pick<SessionUser, "role" | "isPrimaryAdmin">,
): void {
	if (!isPrimaryAdmin(user)) {
		throw new Error("Forbidden");
	}
}

/** picanteverde fork: admin is all-or-nothing; the granular upstream flags are ignored. */
export function canManageDomains(user: Pick<SessionUser, "role">): boolean {
	return isAdmin(user);
}

/** picanteverde fork: admin is all-or-nothing; the granular upstream flags are ignored. */
export function canManageUsers(user: Pick<SessionUser, "role">): boolean {
	return isAdmin(user);
}
