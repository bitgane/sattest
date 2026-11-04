import type { EventTemplate, VerifiedEvent } from 'nostr-tools';
import { nip44DecryptWithStoredSigner, signWithStoredSigner } from './nostr.api.js';
import {
  SignerCancelledError,
  SignerTimeoutError,
  SignerUnresponsiveError,
} from './signer-errors.js';

/**
 * The user's signer, with recovery.
 *
 * Every write is now a Nostr event the user signs (there is no server to hold
 * a session), so a stale signer session is the most common failure: the
 * bunker pointer was ended in the signer app and nothing will ever answer.
 * Re-pairing mints a fresh pointer — so on a timeout, or when no identity is
 * stored at all, offer the Connect-to-Nostr QR and retry once. If the retry
 * times out too, re-pairing didn't help (the signer is asking per signature)
 * and we stop with a diagnosis instead of looping.
 *
 * Re-pairing needs VS Code UI, so the extension registers the routine at
 * activation (`setAuthRefresher`) rather than this module importing the
 * command layer.
 */

type AuthRefresher = () => Promise<boolean>;

let refresher: AuthRefresher | undefined;
// N concurrent failures share one reconnect instead of stacking N QR panels.
let inFlightReauth: Promise<boolean> | undefined;

/** Register the interactive re-pair routine (called once from activate). */
export function setAuthRefresher(fn: AuthRefresher | undefined): void {
  refresher = fn;
}

async function reauth(): Promise<boolean> {
  if (!refresher) {
    return false;
  }
  if (!inFlightReauth) {
    inFlightReauth = Promise.resolve(refresher()).finally(() => {
      inFlightReauth = undefined;
    });
  }
  return inFlightReauth;
}

function isMissingIdentity(err: unknown): boolean {
  return err instanceof Error && err.message.includes('Nostr authentication required');
}

export interface SignerCallOptions {
  /** Offer a re-pair on failure (default true). Off for background work. */
  interactiveReauth?: boolean;
}

async function withRecovery<T>(
  operation: string,
  run: () => Promise<T>,
  opts: SignerCallOptions = {}
): Promise<T> {
  const interactive = opts.interactiveReauth ?? true;
  try {
    return await run();
  } catch (error) {
    if (error instanceof SignerCancelledError) {
      throw error; // the user chose to stop — never retry
    }
    if (!interactive || !(error instanceof SignerTimeoutError || isMissingIdentity(error))) {
      throw error;
    }
    if (!(await reauth())) {
      throw error;
    }
    try {
      return await run();
    } catch (retryError) {
      if (retryError instanceof SignerTimeoutError) {
        throw new SignerUnresponsiveError(operation);
      }
      throw retryError;
    }
  }
}

/** Sign `template` as the connected user. */
export function signUserEvent(
  template: EventTemplate,
  operation: string,
  opts?: SignerCallOptions
): Promise<VerifiedEvent> {
  return withRecovery(operation, () => signWithStoredSigner(template, operation), opts);
}

/** NIP-44 decrypt something `senderPubkey` encrypted to the connected user. */
export function decryptForUser(
  senderPubkey: string,
  ciphertext: string,
  operation: string,
  opts?: SignerCallOptions
): Promise<string> {
  return withRecovery(
    operation,
    () => nip44DecryptWithStoredSigner(senderPubkey, ciphertext, operation),
    opts
  );
}
