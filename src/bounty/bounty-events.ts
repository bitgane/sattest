import { randomUUID } from 'crypto';
import { generateSecretKey, getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import type { Event, EventTemplate } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import { getPow } from 'nostr-tools/nip13';
import {
  ANNOUNCEMENT_HASHTAG,
  ANNOUNCEMENT_KIND,
  BOUNTY_EVENT_STATUSES,
  BOUNTY_KIND,
  BountyEventStatus,
  CLAIM_EVENT_STATUSES,
  CLAIM_KIND,
  ClaimEventStatus,
  MAX_BOUNTY_SATS,
  MIN_BOUNTY_SATS,
  MIN_CLAIM_POW,
  PROTOCOL_VERSION,
  TAG,
  coordinate,
  parseCoordinate,
} from '../api/nostr-protocol.js';
import {
  BountyInfo,
  BountyPayout,
  ClaimInfo,
  ClaimStatus,
  claimStatusApproved,
  claimStatusApproving,
  claimStatusPending,
} from './bounty.types.js';

/**
 * Build, parse and validate Sattest's Nostr events.
 *
 * With no server, every client is its own validator: an event is only ever
 * trusted for what its *signature* can vouch for. Concretely —
 *
 *  - A bounty's state (amount, test, status, payout) comes only from events
 *    signed by its creator. Addressable coordinates include the author, so no
 *    other key — the Sattest project account included — can publish a version
 *    of someone else's bounty.
 *  - A claim is whatever its claimant signed. One claim per claimant per bounty
 *    falls out of the claim's `d` tag being the bounty coordinate.
 *  - Of several versions, the newest `created_at` wins; ties go to the lowest
 *    event id (the NIP-01 rule relays use).
 *
 * Everything here is pure: no relays, no signer, no VS Code.
 */

/** Decrypted bounty payload (bounty event content, encrypted with the repo key). */
export interface BountyContent {
  v: number;
  testId: string;
  testLabel?: string;
  amountSats: number;
  repoSlug?: string;
  memo?: string;
}

/** Decrypted claim payload (claim event content, encrypted to the creator). */
export interface ClaimContent {
  v: number;
  lnurl: string;
}

export interface ParsedBounty {
  event: Event;
  id: string;
  coordinate: string;
  creator: string;
  repoId: string;
  status: BountyEventStatus;
  content: BountyContent;
  payout?: BountyPayout;
}

export interface ParsedClaim {
  event: Event;
  claimant: string;
  bountyCoordinate: string;
  bountyId: string;
  creator: string;
  repoId: string;
  status: ClaimEventStatus;
  ephemeralPubkey: string;
  publicConsent: boolean;
  pow: number;
}

const HEX64 = /^[0-9a-f]{64}$/;

function tagValue(event: { tags: string[][] }, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

/**
 * Verify an event's id and signature from its fields alone.
 *
 * nostr-tools caches a successful verification on the object itself, and that
 * marker survives an object spread — so `{ ...signed, sig: forged }` would pass
 * `verifyEvent`. Rebuilding a plain object forces a real check every time.
 */
export function hasValidSignature(event: Event): boolean {
  const { id, pubkey, created_at, kind, tags, content, sig } = event;
  return verifyEvent({ id, pubkey, created_at, kind, tags, content, sig });
}

/** A fresh bounty id (the `d` tag). */
export function newBountyId(): string {
  return randomUUID();
}

/**
 * `created_at` for a new version of an addressable event. Relays keep only the
 * newest version, so a skewed clock that stamps a status change *earlier* than
 * the version it replaces would make the change vanish. Never go backwards.
 */
export function nextCreatedAt(previous?: number, now = Math.floor(Date.now() / 1000)): number {
  return previous !== undefined && previous >= now ? previous + 1 : now;
}

/** Validate decrypted bounty content; undefined when unusable. */
export function validateBountyContent(raw: unknown): BountyContent | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const c = raw as Record<string, unknown>;
  if (typeof c.testId !== 'string' || c.testId.length === 0 || c.testId.length > 500) {
    return undefined;
  }
  if (
    typeof c.amountSats !== 'number' ||
    !Number.isInteger(c.amountSats) ||
    c.amountSats < MIN_BOUNTY_SATS ||
    c.amountSats > MAX_BOUNTY_SATS
  ) {
    return undefined;
  }
  const optionalString = (v: unknown, max: number) =>
    typeof v === 'string' ? v.slice(0, max) : undefined;
  return {
    v: typeof c.v === 'number' ? c.v : PROTOCOL_VERSION,
    testId: c.testId,
    amountSats: c.amountSats,
    testLabel: optionalString(c.testLabel, 300),
    repoSlug: optionalString(c.repoSlug, 200),
    memo: optionalString(c.memo, 500),
  };
}

export interface BuildBountyParams {
  id: string;
  repoId: string;
  repoKey: Uint8Array;
  content: Omit<BountyContent, 'v'>;
  status: BountyEventStatus;
  payout?: BountyPayout;
  /** `created_at` of the version being replaced, if any. */
  previousCreatedAt?: number;
  now?: number;
}

/** Build (unsigned) a bounty event version. */
export function buildBountyEvent(params: BuildBountyParams): EventTemplate {
  const content = validateBountyContent({ v: PROTOCOL_VERSION, ...params.content });
  if (!content) {
    throw new Error('Invalid bounty content');
  }
  const tags: string[][] = [
    [TAG.identifier, params.id],
    [TAG.repo, params.repoId],
    [TAG.status, params.status],
    [TAG.alt, 'Sattest test bounty (details are encrypted to the repository)'],
  ];
  const p = params.payout;
  if (p && (params.status === 'approving' || params.status === 'paid')) {
    if (p.claimEventId) {
      tags.push([TAG.event, p.claimEventId]);
    }
    if (p.claimantPubkey) {
      tags.push([TAG.pubkey, p.claimantPubkey]);
    }
    if (p.paymentHash) {
      tags.push([TAG.paymentHash, p.paymentHash]);
    }
    if (params.status === 'paid') {
      if (p.preimage) {
        tags.push([TAG.preimage, p.preimage]);
      }
      if (p.paidAt !== undefined) {
        tags.push([TAG.paidAt, String(p.paidAt)]);
      }
      if (p.resolution) {
        tags.push([TAG.resolution, p.resolution]);
      }
    }
  }
  return {
    kind: BOUNTY_KIND,
    created_at: nextCreatedAt(params.previousCreatedAt, params.now),
    tags,
    content: nip44.encrypt(JSON.stringify(content), params.repoKey),
  };
}

/**
 * Parse and validate a bounty event. Returns undefined for anything that isn't
 * a well-formed, correctly-signed bounty in this repository that decrypts with
 * the repository key.
 */
export function parseBountyEvent(
  event: Event,
  repoKey: Uint8Array,
  repoId?: string
): ParsedBounty | undefined {
  if (event.kind !== BOUNTY_KIND || !hasValidSignature(event)) {
    return undefined;
  }
  const id = tagValue(event, TAG.identifier);
  const eventRepoId = tagValue(event, TAG.repo);
  const status = tagValue(event, TAG.status) as BountyEventStatus | undefined;
  if (!id || !eventRepoId || !status || !BOUNTY_EVENT_STATUSES.includes(status)) {
    return undefined;
  }
  if (repoId && eventRepoId !== repoId) {
    return undefined;
  }
  let content: BountyContent | undefined;
  try {
    content = validateBountyContent(JSON.parse(nip44.decrypt(event.content, repoKey)));
  } catch {
    return undefined; // not encrypted to this repository, or tampered
  }
  if (!content) {
    return undefined;
  }

  let payout: BountyPayout | undefined;
  if (status === 'approving' || status === 'paid') {
    const paidAt = Number(tagValue(event, TAG.paidAt));
    payout = {
      claimEventId: tagValue(event, TAG.event),
      claimantPubkey: tagValue(event, TAG.pubkey),
      paymentHash: tagValue(event, TAG.paymentHash),
      preimage: tagValue(event, TAG.preimage),
      paidAt: Number.isFinite(paidAt) ? paidAt : undefined,
      resolution: tagValue(event, TAG.resolution),
    };
  }

  return {
    event,
    id,
    coordinate: coordinate(BOUNTY_KIND, event.pubkey, id),
    creator: event.pubkey,
    repoId: eventRepoId,
    status,
    content,
    payout,
  };
}

export interface BuildClaimParams {
  bountyCoordinate: string;
  repoId: string;
  lnurl: string;
  status?: ClaimEventStatus;
  publicConsent?: boolean;
  previousCreatedAt?: number;
  now?: number;
  /** Test hook — normally a fresh key per claim. */
  ephemeralSecret?: Uint8Array;
}

/**
 * Build (unsigned) a claim event. The payout address is encrypted to the
 * bounty creator with a throwaway sender key, so it never appears in public
 * and the claimant's signer isn't needed to encrypt it — only to sign.
 */
export function buildClaimEvent(params: BuildClaimParams): EventTemplate {
  const parsed = parseCoordinate(params.bountyCoordinate);
  if (!parsed || parsed.kind !== BOUNTY_KIND) {
    throw new Error('Invalid bounty coordinate');
  }
  const ephemeralSecret = params.ephemeralSecret ?? generateSecretKey();
  const payload: ClaimContent = { v: PROTOCOL_VERSION, lnurl: params.lnurl.trim() };
  const tags: string[][] = [
    [TAG.identifier, params.bountyCoordinate],
    [TAG.address, params.bountyCoordinate],
    [TAG.pubkey, parsed.pubkey],
    [TAG.repo, params.repoId],
    [TAG.status, params.status ?? 'pending'],
    [TAG.ephemeralKey, getPublicKey(ephemeralSecret)],
    [TAG.alt, 'Sattest bounty claim'],
  ];
  if (params.publicConsent) {
    tags.push([TAG.publicConsent, 'payout']);
  }
  return {
    kind: CLAIM_KIND,
    created_at: nextCreatedAt(params.previousCreatedAt, params.now),
    tags,
    content: nip44.encrypt(
      JSON.stringify(payload),
      nip44.getConversationKey(ephemeralSecret, parsed.pubkey)
    ),
  };
}

/**
 * Add NIP-13 proof of work to a claim template for `pubkey`. The returned
 * template must be signed unchanged — the work is bound to the event id.
 */
export function mineClaimPow(
  template: EventTemplate,
  pubkey: string,
  difficulty = MIN_CLAIM_POW
): EventTemplate {
  // Hand-rolled rather than nip13.minePow, which re-stamps created_at while it
  // mines — that would undo nextCreatedAt's never-go-backwards guarantee.
  const tags = template.tags.filter((t) => t[0] !== 'nonce').map((t) => [...t]);
  const nonceTag = ['nonce', '0', String(difficulty)];
  tags.push(nonceTag);
  const unsigned = { ...template, tags, pubkey };
  for (let nonce = 0; ; nonce++) {
    nonceTag[1] = String(nonce);
    if (getPow(getEventHash(unsigned)) >= difficulty) {
      return { kind: template.kind, created_at: template.created_at, tags, content: template.content };
    }
  }
}

/** Parse and validate a claim event; undefined when it doesn't qualify. */
export function parseClaimEvent(
  event: Event,
  opts: { minPow?: number; repoId?: string } = {}
): ParsedClaim | undefined {
  if (event.kind !== CLAIM_KIND || !hasValidSignature(event)) {
    return undefined;
  }
  const d = tagValue(event, TAG.identifier);
  const a = tagValue(event, TAG.address);
  const p = tagValue(event, TAG.pubkey);
  const repoId = tagValue(event, TAG.repo);
  const status = tagValue(event, TAG.status) as ClaimEventStatus | undefined;
  const epk = tagValue(event, TAG.ephemeralKey);
  if (!d || d !== a || !repoId || !status || !CLAIM_EVENT_STATUSES.includes(status)) {
    return undefined;
  }
  if (!epk || !HEX64.test(epk)) {
    return undefined;
  }
  const target = parseCoordinate(d);
  if (!target || target.kind !== BOUNTY_KIND || target.pubkey !== p) {
    return undefined;
  }
  if (opts.repoId && repoId !== opts.repoId) {
    return undefined;
  }
  const pow = getPow(event.id);
  if (pow < (opts.minPow ?? MIN_CLAIM_POW)) {
    return undefined;
  }
  return {
    event,
    claimant: event.pubkey,
    bountyCoordinate: d,
    bountyId: target.d,
    creator: target.pubkey,
    repoId,
    status,
    ephemeralPubkey: epk,
    publicConsent: event.tags.some((t) => t[0] === TAG.publicConsent),
    pow,
  };
}

/**
 * Decrypt a claim's payout address. `decrypt` is the creator's NIP-44 decrypt
 * (their signer), called with the claim's ephemeral sender key.
 */
export async function decryptClaimLnurl(
  claim: Pick<ClaimInfo, 'encryptedLnurl' | 'ephemeralPubkey'>,
  decrypt: (senderPubkey: string, ciphertext: string) => Promise<string>
): Promise<string> {
  const plaintext = await decrypt(claim.ephemeralPubkey, claim.encryptedLnurl);
  const parsed = JSON.parse(plaintext) as Partial<ClaimContent>;
  if (typeof parsed.lnurl !== 'string' || parsed.lnurl.trim().length === 0) {
    throw new Error('Claim carries no payout address');
  }
  return parsed.lnurl.trim();
}

/** NIP-01 ordering for versions of one addressable event: newest wins, then lowest id. */
export function isNewerVersion(a: Event, b: Event): boolean {
  if (a.created_at !== b.created_at) {
    return a.created_at > b.created_at;
  }
  return a.id < b.id;
}

/** Reduce a set of events to the newest version per `kind:pubkey:d`. */
export function latestVersions(events: Event[]): Event[] {
  const byCoordinate = new Map<string, Event>();
  for (const event of events) {
    const d = tagValue(event, TAG.identifier) ?? '';
    const key = coordinate(event.kind, event.pubkey, d);
    const current = byCoordinate.get(key);
    if (!current || isNewerVersion(event, current)) {
      byCoordinate.set(key, event);
    }
  }
  return [...byCoordinate.values()];
}

/** Claim status as the UI shows it, derived from the bounty's payout record. */
function claimStatusFor(bounty: ParsedBounty, claim: ParsedClaim): ClaimStatus {
  if (bounty.payout?.claimantPubkey === claim.claimant) {
    if (bounty.status === 'paid') {
      return claimStatusApproved;
    }
    if (bounty.status === 'approving') {
      return claimStatusApproving;
    }
  }
  return claimStatusPending;
}

/**
 * Assemble the UI model for one bounty from its newest version and the claims
 * that reference it. Withdrawn claims are dropped; claims filed after a bounty
 * closed are dropped too, except the one it was paid to.
 */
export function toBountyInfo(bounty: ParsedBounty, claims: ParsedClaim[]): BountyInfo {
  const closedAt =
    bounty.status === 'paid' || bounty.status === 'cancelled'
      ? bounty.event.created_at
      : Infinity;
  const relevant = claims
    .filter((c) => c.bountyCoordinate === bounty.coordinate && c.status === 'pending')
    .filter(
      (c) =>
        c.event.created_at <= closedAt || c.claimant === bounty.payout?.claimantPubkey
    )
    .sort((x, y) => y.event.created_at - x.event.created_at);

  return {
    id: bounty.id,
    coordinate: bounty.coordinate,
    eventId: bounty.event.id,
    eventCreatedAt: bounty.event.created_at,
    createdAt: new Date(bounty.event.created_at * 1000),
    creatorId: bounty.creator,
    amountSats: bounty.content.amountSats,
    testId: bounty.content.testId,
    testLabel: bounty.content.testLabel,
    repoSlug: bounty.content.repoSlug,
    memo: bounty.content.memo,
    status: bounty.status,
    active: bounty.status === 'open' || bounty.status === 'approving',
    payout: bounty.payout,
    claims: relevant.map((c) => ({
      id: c.event.id,
      bountyId: bounty.id,
      claimantPubkey: c.claimant,
      claimedAt: new Date(c.event.created_at * 1000),
      status: claimStatusFor(bounty, c),
      encryptedLnurl: c.event.content,
      ephemeralPubkey: c.ephemeralPubkey,
      publicConsent: c.publicConsent,
    })),
  };
}

/**
 * Turn raw bounty + claim events for one repository into UI models. Invalid
 * events are skipped silently — on a public network they're expected.
 */
export function assembleBounties(
  events: Event[],
  repoKey: Uint8Array,
  repoId: string,
  opts: { minClaimPow?: number } = {}
): BountyInfo[] {
  const latest = latestVersions(events);
  const bounties: ParsedBounty[] = [];
  const claims: ParsedClaim[] = [];
  for (const event of latest) {
    if (event.kind === BOUNTY_KIND) {
      const parsed = parseBountyEvent(event, repoKey, repoId);
      if (parsed) {
        bounties.push(parsed);
      }
    } else if (event.kind === CLAIM_KIND) {
      const parsed = parseClaimEvent(event, { minPow: opts.minClaimPow, repoId });
      if (parsed) {
        claims.push(parsed);
      }
    }
  }
  return bounties
    .map((b) => toBountyInfo(b, claims))
    .sort((x, y) => y.eventCreatedAt - x.eventCreatedAt);
}

/** Inputs for an opt-in public announcement (a plain kind-1 note). */
export interface AnnouncementParams {
  kind: 'bounty' | 'payout';
  bountyCoordinate: string;
  amountSats: number;
  testLabel: string;
  repoSlug?: string;
  /** Pubkey of the Sattest project account, tagged so it can repost. */
  sattestPubkey: string;
  /** Claimant pubkey — payout announcements only, and only with consent. */
  claimantPubkey?: string;
}

/**
 * Build an opt-in public announcement. Only ever published after the user
 * agreed to make these details public — the bounty event itself stays
 * encrypted regardless.
 */
export function buildAnnouncement(params: AnnouncementParams): EventTemplate {
  const where = params.repoSlug ? ` in ${params.repoSlug}` : '';
  const content =
    params.kind === 'bounty'
      ? `⚡ New ${params.amountSats} sat bounty${where}: make "${params.testLabel}" pass. #${ANNOUNCEMENT_HASHTAG}`
      : `✅ ${params.amountSats} sat bounty paid${where} for "${params.testLabel}". #${ANNOUNCEMENT_HASHTAG}`;
  const tags: string[][] = [
    [TAG.address, params.bountyCoordinate],
    [TAG.hashtag, ANNOUNCEMENT_HASHTAG],
    [TAG.announce, params.kind],
  ];
  if (params.sattestPubkey) {
    tags.push([TAG.pubkey, params.sattestPubkey]);
  }
  if (params.kind === 'payout' && params.claimantPubkey) {
    tags.push([TAG.pubkey, params.claimantPubkey]);
  }
  return {
    kind: ANNOUNCEMENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
  };
}
