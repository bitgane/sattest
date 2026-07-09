import { getNostrAuthEvent } from '../state.js';
import { getBackendUrl } from './config.js';
import { signMoneyAuthEvent } from './nostr.api.js';

/**
 * Returns headers for authenticating requests to the sattest backend
 * using a signed Nostr event (created during Nostr connection).
 *
 * The Authorization header contains: Nostr <base64(JSON(signedEvent))>
 * The backend verifies the event signature to authenticate the user's pubkey.
 */

function encodeAuthHeader(event: object, extra?: Record<string, string>): Record<string, string> {
  const encoded = Buffer.from(JSON.stringify(event)).toString('base64');
  return {
    Authorization: `Nostr ${encoded}`,
    ...extra,
  };
}

/** Headers for read-only endpoints (`nostrAuth` middleware). */
export async function getNostrAuthHeaders(
  extra?: Record<string, string>
): Promise<Record<string, string>> {
  const eventJson = await getNostrAuthEvent();
  if (!eventJson) {
    throw new Error(
      'Nostr authentication required (read scope). Use "Connect Nostr" (Ctrl+Alt+N) first.'
    );
  }
  return encodeAuthHeader(JSON.parse(eventJson), extra);
}

/**
 * Fetches a short-lived, single-use nonce from the backend (F4 hardening).
 * Uses the cheap, reusable read credential — issuing a nonce never requires
 * a signer round-trip, only the money call that follows does.
 */
async function fetchAuthNonce(): Promise<string> {
  const readHeaders = await getNostrAuthHeaders();
  const response = await fetch(`${getBackendUrl()}/auth/nonce`, {
    method: 'POST',
    headers: readHeaders,
  });
  if (!response.ok) {
    throw new Error(`Failed to obtain auth nonce: backend returned ${response.status}`);
  }
  const data = (await response.json()) as { nonce?: string };
  if (!data.nonce) {
    throw new Error('Backend did not return a nonce');
  }
  return data.nonce;
}

/**
 * Headers for money-moving endpoints (`moneyAuth` middleware).
 *
 * Unlike the read credential, this is NOT cached: `moneyAuth` requires a
 * server-issued, single-use nonce (F4 hardening), so every money-moving call
 * fetches a fresh nonce and signs a brand-new write-scope credential
 * (`content: 'sattest-auth:write'`) bound to it. This costs a signer
 * round-trip per money call, in exchange for a captured write credential no
 * longer being replayable — the nonce that gave it validity is consumed on
 * first use.
 */
export async function getNostrMoneyAuthHeaders(
  extra?: Record<string, string>
): Promise<Record<string, string>> {
  const nonce = await fetchAuthNonce();
  const event = await signMoneyAuthEvent(nonce);
  return encodeAuthHeader(event, extra);
}
