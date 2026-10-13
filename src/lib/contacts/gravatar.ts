// picanteverde fork: Gravatar lookups are disabled.
//
// Upstream fetched https://gravatar.com/avatar/<sha256(email)> for every new contact
// (each inbound sender and outbound recipient). That tells a third party who this
// mailbox corresponds with, and SHA-256 of a known address is trivially reversible.
// Contacts simply keep no avatar unless one is uploaded by hand; callers already
// handle a null result.
export async function importGravatarAvatar(
	_env: CloudflareEnv,
	_userId: string,
	_email: string,
): Promise<string | null> {
	return null;
}
