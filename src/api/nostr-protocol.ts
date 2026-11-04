import * as nip19 from 'nostr-tools/nip19';

/**
 * Sattest's Nostr wire protocol — the single source of truth for event kinds,
 * tag names and the protocol's validation bounds.
 *
 * There is no server, so every client has to agree on exactly these values to
 * read each other's bounties. `docs/nostr-protocol.md` is the human-readable
 * spec; `nostr-protocol.contract.test.ts` pins the literals so an accidental
 * edit fails loudly instead of silently forking the network.
 *
 * The kinds are provisional and unregistered (nothing in the NIPs registry
 * uses the 374xx range). Both are *addressable* (30000–39999): relays keep
 * only the newest version per (kind, author, `d` tag), which is what gives a
 * bounty a current status and a claimant exactly one claim per bounty.
 */

/** Bounty definition + status. Authored by the bounty creator. `d` = UUID. */
export const BOUNTY_KIND = 37400;

/** A claim on a bounty. Authored by the claimant. `d` = the bounty coordinate. */
export const CLAIM_KIND = 37401;

/** Plain note kind used for opt-in public announcements. */
export const ANNOUNCEMENT_KIND = 1;

/** Version stamped into encrypted payloads so the format can evolve. */
export const PROTOCOL_VERSION = 1;

/** Bounty lifecycle carried in the bounty event's `status` tag. */
export type BountyEventStatus = 'open' | 'approving' | 'paid' | 'cancelled';
export const BOUNTY_EVENT_STATUSES: readonly BountyEventStatus[] = [
  'open',
  'approving',
  'paid',
  'cancelled',
];

/** Claim lifecycle carried in the claim event's `status` tag. */
export type ClaimEventStatus = 'pending' | 'withdrawn';
export const CLAIM_EVENT_STATUSES: readonly ClaimEventStatus[] = ['pending', 'withdrawn'];

/** Bounty amount bounds (sats). Out-of-range bounties are ignored by clients. */
export const MIN_BOUNTY_SATS = 1;
export const MAX_BOUNTY_SATS = 50_000;

/**
 * NIP-13 proof-of-work a claim must carry to be shown to the creator.
 *
 * Nostr keypairs are free, so without a cost per claim one person could bury a
 * bounty under thousands of junk claims. 16 leading zero bits is well under a
 * second of hashing for an honest claimant and makes bulk spam proportionally
 * expensive.
 */
export const MIN_CLAIM_POW = 16;

/** Tag names used by Sattest events (single letters are relay-indexed). */
export const TAG = {
  identifier: 'd',
  repo: 'r',
  address: 'a',
  event: 'e',
  pubkey: 'p',
  hashtag: 't',
  status: 'status',
  alt: 'alt',
  paymentHash: 'payment_hash',
  preimage: 'preimage',
  paidAt: 'paid_at',
  resolution: 'resolution',
  ephemeralKey: 'epk',
  publicConsent: 'public',
  announce: 'sattest-announce',
} as const;

/** `resolution` value when the creator confirmed an unverifiable payout. */
export const RESOLUTION_CREATOR_CONFIRMED = 'creator-confirmed';

/** Hashtag on opt-in public announcements. */
export const ANNOUNCEMENT_HASHTAG = 'sattest';

/**
 * The Sattest project account, as an `npub` or 64-char hex public key. Opt-in
 * public announcements tag it so the separate announcer service can repost
 * them.
 *
 * Only the PUBLIC key ever lives here. The account's private key must never be
 * shipped in the extension — anything in the .vsix is readable by anyone — and
 * an `nsec` here is rejected. The account is also never trusted for bounty
 * state: clients only accept status changes signed by the bounty creator.
 *
 * Typed as `string` on purpose: with an inferred literal type, comparing it to
 * another literal is a compile error. Leave it empty to turn announcements off.
 */
export const SATTEST_ACCOUNT: string =
  'npub17789nud60ecdnj4vx8sap65px0heeknll7zxfsjf082mkskv6kdq70hq5t';

/**
 * Normalize an account key (npub or 64-hex) to lowercase hex, as used in `p`
 * tags. Returns undefined for empty, malformed, or private (`nsec`) input.
 */
export function normalizeAccountKey(value: string): string | undefined {
  const v = value.trim();
  if (!v) {
    return undefined;
  }
  if (/^[0-9a-f]{64}$/i.test(v)) {
    return v.toLowerCase();
  }
  if (!v.toLowerCase().startsWith('npub1')) {
    return undefined; // never accept an nsec or anything else
  }
  try {
    const decoded = nip19.decode(v.toLowerCase());
    return decoded.type === 'npub' ? (decoded.data as string) : undefined;
  } catch {
    return undefined;
  }
}

let warnedBadAccount = false;

/** The Sattest account's hex public key, or undefined when not (validly) set. */
export function sattestAccountPubkey(): string | undefined {
  const hex = normalizeAccountKey(SATTEST_ACCOUNT);
  if (!hex && SATTEST_ACCOUNT.trim() && !warnedBadAccount) {
    warnedBadAccount = true;
    console.warn(
      '[sattest] SATTEST_ACCOUNT is not a valid npub or hex public key; announcements are off.'
    );
  }
  return hex;
}

/**
 * Whether opt-in public announcements are offered at all. Off until a valid
 * project account key is configured; every prompt that offers an announcement
 * checks this, so they switch on and off together.
 */
export function announcementsEnabled(): boolean {
  return sattestAccountPubkey() !== undefined;
}

/**
 * Permissions requested up front in the `nostrconnect://` URI.
 *
 * Without these the signer only grants what the user taps through during
 * pairing, so a later background request (publishing a claim, the payout
 * status) can sit waiting on an approval prompt the user never sees.
 */
export const REQUESTED_SIGNER_PERMS = [
  'get_public_key',
  `sign_event:${BOUNTY_KIND}`,
  `sign_event:${CLAIM_KIND}`,
  `sign_event:${ANNOUNCEMENT_KIND}`,
  'nip44_decrypt',
];

/** `kind:pubkey:d` coordinate of an addressable event. */
export function coordinate(kind: number, pubkey: string, d: string): string {
  return `${kind}:${pubkey}:${d}`;
}

/** Parse a `kind:pubkey:d` coordinate; undefined when malformed. */
export function parseCoordinate(
  value: string
): { kind: number; pubkey: string; d: string } | undefined {
  const match = /^(\d+):([0-9a-f]{64}):(.+)$/.exec(value);
  if (!match) {
    return undefined;
  }
  return { kind: Number(match[1]), pubkey: match[2], d: match[3] };
}
