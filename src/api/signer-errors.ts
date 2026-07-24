/**
 * Signer error types, kept in their own module deliberately.
 *
 * `authed-fetch` needs to recognise a stalled signer, but importing that from
 * `nostr.api` would drag the whole `nostr-tools` ESM chain into every module
 * (and every test) that touches `authedFetch`. This file has no dependencies,
 * so both sides can share the type cheaply.
 */

/**
 * How long any single NIP-46 request to the remote signer may take before we
 * give up and surface an actionable error.
 *
 * Generous because the signer may be prompting the user to approve — but
 * bounded, because an unanswered request otherwise hangs forever: `signEvent`
 * has no timeout of its own, so a backgrounded nsec.app tab or a locked Amber
 * left an approve/create silently stuck with no POST, no toast, and no way to
 * tell what happened.
 */
export const SIGNER_REQUEST_TIMEOUT_MS = 60000;

/**
 * Thrown when the remote signer doesn't answer within
 * `SIGNER_REQUEST_TIMEOUT_MS`. Distinct from "no credential stored" so callers
 * can tell a stalled signer (retry once it's awake) from a lapsed session
 * (re-pair) — notably `authedFetch`, which must NOT pop the re-pair QR for a
 * timeout.
 */
export class SignerTimeoutError extends Error {
  constructor(operation: string) {
    super(
      `Your Nostr signer didn't respond to the ${operation} request within ` +
        `${Math.round(SIGNER_REQUEST_TIMEOUT_MS / 1000)}s. Open your signer ` +
        '(nsec.app tab / Amber), approve any pending request, and try again.'
    );
    this.name = 'SignerTimeoutError';
  }
}
