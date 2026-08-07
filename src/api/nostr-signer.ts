import { nip04, nip44, SimplePool } from 'nostr-tools';

/** NIP-46 messages travel as kind 24133 (ephemeral — relays don't store them). */
const NOSTR_CONNECT_KIND = 24133;

/**
 * Waits for the remote signer's "connect" response after the user scans our
 * nostrconnect:// QR. Resolves with the signer's pubkey.
 *
 * This replaces nostr-tools' `BunkerSigner.fromURI` handshake, whose matcher is
 * too strict for real-world signers and silently drops their responses — the
 * root cause of the "have to connect twice" bug:
 *   • it only decrypts NIP-44, but several signers (Primal among them) encrypt
 *     the connect response with NIP-04 → decrypt throws → event dropped.
 * We accept both encodings and log anything we drop so the next interop quirk
 * is diagnosable instead of silent.
 *
 * THE CONNECT SECRET IS NOT OPTIONAL. NIP-46 requires the signer to echo the
 * one-time `secret` from the nostrconnect:// URI — it is the only thing that
 * authenticates the answering signer: our subscription filter (`#p:
 * [clientPubkey]`) tells every configured relay exactly who to target, and
 * anyone who saw the QR knows it too, so both can encrypt a payload to us —
 * but neither knows the secret, which never leaves this machine except inside
 * the URI. The legacy `result: "ack"` shape some signers send is therefore
 * REJECTED, not accepted: a malicious relay could otherwise win the race
 * against the user's real signer (first response wins, and the relay can
 * answer milliseconds after the subscription opens — long before a human
 * scans the QR) and bind this session to the attacker's key. Every later
 * money call is signed by whatever signer we pair with, and the victim's NWC
 * spending grant is stored server-side under the paired pubkey — a hijacked
 * pairing hands the victim's wallet budget to the attacker.
 */
export function waitForSignerHandshake(
  pool: SimplePool,
  relays: string[],
  clientSecretBytes: Uint8Array,
  clientPubkey: string,
  secret: string,
  timeoutMs = 90000
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      try {
        sub.close();
      } catch {
        /* already closed */
      }
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('Timeout'))), timeoutMs);

    const sub = pool.subscribe(
      relays,
      { kinds: [NOSTR_CONNECT_KIND], '#p': [clientPubkey] },
      {
        onevent: (event) => {
          if (done) {
            return;
          }
          // Decrypt NIP-44 first (current spec), fall back to NIP-04 (what a
          // number of signers still send for the connect response).
          let payload: string;
          try {
            payload = nip44.decrypt(
              event.content,
              nip44.getConversationKey(clientSecretBytes, event.pubkey)
            );
          } catch {
            try {
              payload = nip04.decrypt(clientSecretBytes, event.pubkey, event.content);
            } catch {
              console.warn(
                '[Nostr Connect] Dropping undecryptable kind-24133 event from',
                event.pubkey
              );
              return;
            }
          }
          try {
            const response = JSON.parse(payload);
            // Only the secret echo authenticates the signer (see the function
            // docblock). A legacy "ack" carries no proof the responder knows
            // the secret — it could come from any relay that saw our
            // subscription — so it is rejected as a possible hijack attempt.
            if (response.result === secret) {
              finish(() => resolve(event.pubkey));
            } else if (response.result === 'ack') {
              console.warn(
                '[Nostr Connect] Rejected legacy "ack" connect response: it does not echo the ' +
                  'pairing secret and cannot be authenticated (possible pairing-hijack attempt). ' +
                  'Update your signer — NIP-46 requires echoing the secret.'
              );
            } else if (response.error) {
              console.warn('[Nostr Connect] Signer reported error during connect:', response.error);
            } else {
              console.warn(
                '[Nostr Connect] Ignoring connect response with unexpected result:',
                response.result
              );
            }
          } catch (e) {
            console.warn('[Nostr Connect] Malformed connect payload:', e);
          }
        },
        onclose: () =>
          finish(() => reject(new Error('Relay subscription closed before the signer responded'))),
      }
    );
  });
}


/**
 * How long a kind-0 profile lookup waits for relays to answer.
 *
 * `pool.get` resolves as soon as every queried relay sends EOSE, so without a
 * `maxWait` the fastest empty relay decides the result: the promise settles
 * `null` before a slower relay that actually holds the profile can reply. That
 * was a major cause of the "Connected as <hex>" banner.
 */
const PROFILE_LOOKUP_MAX_WAIT_MS = 4000;

/**
 * Resolve a display handle (kind-0 `name` / `nip05` / `username`) for `pubkey`.
 *
 * Returns `undefined` when no profile is found or it carries no usable name.
 * Callers MUST treat that as "unknown" and never persist a placeholder — the
 * stored handle has no refresh path other than `refreshNostrHandleIfStale`, so
 * a persisted fallback sticks around and shows hex in the banner forever.
 *
 * The `@` prefix is applied only to a genuinely resolved name, so a pubkey
 * rendering is never dressed up as a handle.
 */
export async function fetchProfileHandle(
  pool: SimplePool,
  relays: string[],
  pubkey: string
): Promise<string | undefined> {
  try {
    const event = await pool.get(
      relays,
      { kinds: [0], authors: [pubkey] },
      { maxWait: PROFILE_LOOKUP_MAX_WAIT_MS }
    );
    if (!event) {
      return undefined;
    }
    const profile = JSON.parse(event.content || '{}');
    const raw = profile.name || profile.nip05 || profile.username;
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return undefined;
    }
    const name = raw.trim().slice(0, 100);
    return name.startsWith('@') ? name : `@${name}`;
  } catch {
    // Malformed profile JSON, or the lookup itself failed — treat as unknown.
    return undefined;
  }
}

/** Display-only rendering of a pubkey, used when no handle could be resolved. */
export function formatPubkeyForDisplay(pubkey: string): string {
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}

/**
 * True when a stored handle is really a pubkey rendering rather than a name.
 *
 * Recognises the fallback shapes older builds persisted (`<first10>...`, with
 * or without an `@`) plus the current display form, so installs already
 * poisoned by a failed lookup can self-heal instead of showing hex forever.
 */
export function isPubkeyFallbackHandle(handle: string, pubkey: string): boolean {
  const base = handle.startsWith('@') ? handle.slice(1) : handle;
  if (base.trim().length === 0) {
    return true;
  }
  if (base === `${pubkey.slice(0, 10)}...` || base === formatPubkeyForDisplay(pubkey)) {
    return true;
  }
  // Defensive: any pure-hex string that prefixes the pubkey is a slice of it,
  // not a name (real handles aren't hex prefixes of their own pubkey).
  const trimmed = base.replace(/[.…]+$/g, '').toLowerCase();
  return /^[0-9a-f]{4,}$/.test(trimmed) && pubkey.toLowerCase().startsWith(trimmed);
}
