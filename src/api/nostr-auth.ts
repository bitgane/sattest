import { getNostrAuthEvent } from '../state.js';

/**
 * Returns headers for authenticating requests to the sattest backend
 * using a signed Nostr event (created during Nostr connection).
 *
 * The Authorization header contains: Nostr <base64(JSON(signedEvent))>
 * The backend verifies the event signature to authenticate the user's pubkey.
 */
export async function getNostrAuthHeaders(
  extra?: Record<string, string>
): Promise<Record<string, string>> {
  const eventJson = await getNostrAuthEvent();

  if (!eventJson) {
    throw new Error('Nostr authentication required. Use "Connect Nostr" (Ctrl+Alt+N) first.');
  }

  const encoded = Buffer.from(eventJson).toString('base64');

  return {
    Authorization: `Nostr ${encoded}`,
    ...extra,
  };
}
