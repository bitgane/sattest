/**
 * Nostr auth wire-protocol constants — the single source of truth for the
 * extension's signer + header-encoding code.
 *
 * These MUST stay in sync with the backend verifier in
 * `sattest-backend/src/middleware/auth.ts` (its `READ_AUTH_CONTENT` /
 * `WRITE_AUTH_CONTENT` and the kind-22242 check). The two repos speak the same
 * wire format but do not share a package, so a change here is only safe when the
 * matching change lands there too.
 */

/** NIP-42 auth event kind used for every sattest auth credential. */
export const NOSTR_AUTH_KIND = 22242;

/**
 * Content/challenge string for the cheap, reusable read-scope credential
 * (backend `nostrAuth` middleware).
 */
export const READ_AUTH_CONTENT = 'sattest-auth';

/**
 * Content/challenge string for the single-use, write-scope ("money") credential
 * (backend `moneyAuth` middleware).
 */
export const WRITE_AUTH_CONTENT = 'sattest-auth:write';

/**
 * Permissions requested up front in the `nostrconnect://` URI.
 *
 * Without these, the signer only grants what the user happens to tap through
 * during pairing, so a *later* background request (the write-scope credential
 * every money-moving call mints) can sit waiting on an approval the user never
 * sees. Asking for kind-22242 signing at connect time means the signer is
 * primed to answer those without another prompt.
 */
export const REQUESTED_SIGNER_PERMS = ['get_public_key', `sign_event:${NOSTR_AUTH_KIND}`];
