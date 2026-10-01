/**
 * Signer error types and timeouts, kept in their own module deliberately.
 *
 * `authed-fetch` needs to recognise these, but importing them from `nostr.api`
 * would drag the whole `nostr-tools` ESM chain into every module (and every
 * test) that touches `authedFetch`. This file has no dependencies, so both
 * sides can share them cheaply.
 */

/**
 * How long a signer request for a **money/write** operation (approve, create,
 * claim, remove, wallet connect, …) may run before we give up and offer a
 * re-pair.
 *
 * Short on purpose: with `sign_event:22242` requested at pairing time, these
 * signatures are automatic and settle in ~1–2s, so 15s comfortably covers a
 * healthy signer. A breach means the signer is genuinely unreachable — most
 * often a stale bunker pointer after the session was ended in the signer app —
 * which re-pairing (a fresh pointer + auth event) actually fixes.
 */
export const SIGNER_WRITE_TIMEOUT_MS = 15000;

/**
 * How long a signer request during the **connect/pairing** flow itself
 * (`getPublicKey`, the login-signature) may run.
 *
 * Long on purpose, and NOT shortened to the write value: these fire moments
 * after the user has approved the pairing in their signer, so they're
 * legitimately slow (relay propagation + a human tapping approve). Timing them
 * out fast would fail a pairing that's about to succeed — and there is no
 * "re-pair on timeout" escape here, because we're already inside the pair flow.
 */
export const SIGNER_CONNECT_TIMEOUT_MS = 60000;

/**
 * Thrown when the remote signer doesn't answer within the operation's timeout.
 * Distinct from "no credential stored" so callers can tell a stalled signer
 * (offer a re-pair) from other failures. Carries the elapsed budget so the
 * message is accurate whichever timeout applied.
 */
export class SignerTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number = SIGNER_WRITE_TIMEOUT_MS) {
    super(
      `Your Nostr signer didn't respond to the ${operation} request within ` +
        `${Math.round(timeoutMs / 1000)}s. Reconnect your Nostr signer and try again.`
    );
    this.name = 'SignerTimeoutError';
  }
}

/**
 * Thrown when the user clicks Cancel on the "waiting for your signer" notice.
 * Callers treat this as a quiet, intentional abort — no error toast, no
 * re-pair prompt.
 */
export class SignerCancelledError extends Error {
  constructor(operation: string) {
    super(`Cancelled the ${operation}.`);
    this.name = 'SignerCancelledError';
  }
}

/**
 * Thrown after a re-pair fails to unstick a signer — i.e. a second consecutive
 * timeout on the same operation. Re-pairing didn't help, so the signer is
 * likely asking the user to approve every signature by hand; point them at the
 * fix instead of looping the QR again.
 */
export class SignerUnresponsiveError extends Error {
  constructor(operation: string) {
    super(
      `Your Nostr signer connected but still didn't approve the ${operation}. ` +
        'Check the signer’s permission settings for Sattest — it may be set ' +
        'to ask for approval on every signature.'
    );
    this.name = 'SignerUnresponsiveError';
  }
}
