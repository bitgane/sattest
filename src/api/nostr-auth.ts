import { getNostrAuthEvent, getNostrWriteAuthEvent } from '../state.js';

/**
 * Returns headers for authenticating requests to the sattest backend
 * using a signed Nostr event (created during Nostr connection).
 *
 * The Authorization header contains: Nostr <base64(JSON(signedEvent))>
 * The backend verifies the event signature to authenticate the user's pubkey.
 */

async function buildAuthHeaders(
  getEvent: () => Promise<string | undefined>,
  scopeLabel: string,
  extra?: Record<string, string>
): Promise<Record<string, string>> {
  const eventJson = await getEvent();

  if (!eventJson) {
    throw new Error(
      `Nostr authentication required (${scopeLabel} scope). Use "Connect Nostr" (Ctrl+Alt+N) first.`
    );
  }

  const encoded = Buffer.from(eventJson).toString('base64');

  return {
    Authorization: `Nostr ${encoded}`,
    ...extra,
  };
}

/** Headers for read-only endpoints (`nostrAuth` middleware). */
export async function getNostrAuthHeaders(
  extra?: Record<string, string>
): Promise<Record<string, string>> {
  return buildAuthHeaders(getNostrAuthEvent, 'read', extra);
}

/**
 * Headers for money-moving endpoints (`moneyAuth` middleware).
 *
 * Uses the write-scoped credential (`content: 'sattest-auth:write'`) signed
 * at connect time. The backend rejects read credentials on these paths, so
 * a captured read-path auth event cannot be replayed against `/approve` etc.
 */
export async function getNostrMoneyAuthHeaders(
  extra?: Record<string, string>
): Promise<Record<string, string>> {
  return buildAuthHeaders(getNostrWriteAuthEvent, 'write', extra);
}
