import { CustomTestItem } from '../test/test-item-wrapper.js';
import type { BountyEventStatus } from '../api/nostr-protocol.js';

/**
 * A bounty as the extension works with it, built from the newest valid version
 * of the creator's bounty event (kind 37400) plus the claim events that
 * reference it. See `bounty-events.ts` for the mapping and validation rules.
 *
 * Every bounty is non-custodial: no funds are ever held anywhere. The creator's
 * own wallet pays the claimant directly when the creator approves.
 */
export interface BountyInfo {
  /** The event's `d` tag — a UUID. Also salts the git claim-trailer token. */
  id: string;
  /** `37400:<creator>:<id>` — what claims reference. */
  coordinate: string;
  /** Id of the newest bounty event version. */
  eventId: string;
  /** `created_at` (unix seconds) of the newest version. */
  eventCreatedAt: number;
  createdAt: Date;
  /** Bounty creator's Nostr pubkey (the event author). */
  creatorId: string;
  amountSats: number;
  testItem?: CustomTestItem;
  testId: string;
  testLabel?: string;
  /** Display-only `owner/repo`, from the creator's `origin` remote. */
  repoSlug?: string;
  memo?: string;
  status: BountyEventStatus;
  /** Open or mid-payout. Paid and cancelled bounties are inactive. */
  active: boolean;
  claims: ClaimInfo[];
  /** Payout record, set while `approving` and once `paid`. */
  payout?: BountyPayout;
}

export interface BountyPayout {
  claimEventId?: string;
  claimantPubkey?: string;
  paymentHash?: string;
  /** Proof of payment: sha256(preimage) === paymentHash. */
  preimage?: string;
  paidAt?: number;
  /** Set when the creator confirmed an outcome no wallet could report. */
  resolution?: string;
}

/**
 * A claim on a bounty, from the claimant's claim event (kind 37401).
 */
export interface ClaimInfo {
  /** Claim event id — what an approval binds to. */
  id: string;

  /** The bounty's `d` id. */
  bountyId: string;

  /** Claimant's Nostr pubkey (the event author). */
  claimantPubkey: string;

  /** When the claim (this version of it) was published. */
  claimedAt: Date;

  /** Derived from the bounty's payout record — see `bounty-events.ts`. */
  status: ClaimStatus;

  /** Payout address, NIP-44 encrypted to the creator. */
  encryptedLnurl: string;

  /** Ephemeral sender key the payout address was encrypted with. */
  ephemeralPubkey: string;

  /** Claimant agreed to a public payout announcement. */
  publicConsent: boolean;

  // Optional: link to the test item (if already loaded)
  testItem?: CustomTestItem;
}

export type ClaimStatus = 'pending' | 'approving' | 'approved';

export const claimStatusPending: ClaimStatus = 'pending';

/**
 * A payout to this claim is in flight, or its outcome was never confirmed and
 * it is held so it can't be paid twice. The UI treats it as "in progress" —
 * not claimable, no plain approve action.
 */
export const claimStatusApproving: ClaimStatus = 'approving';

export const claimStatusApproved: ClaimStatus = 'approved';
