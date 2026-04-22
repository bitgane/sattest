import { CustomTestItem } from '../test/test-item-wrapper.js';

export interface BountyInfo {
  id: string;
  amountSats: number;
  invoice: string;
  paymentHash?: string; // From LNbits response
  createdAt: Date;
  creatorId: string; // nostr pubkey
  testItem?: CustomTestItem;
  testId: string;
  invoicePaid?: boolean; // Track if invoice paid out
  claims: ClaimInfo[];
  claimedBy?: string; // claimer's invoice or address
  active: boolean;
}

/**
 * Represents a claim on a bounty in the system.
 * Mirrors the 'claims' table schema.
 */
export interface ClaimInfo {
  /** Unique claim ID (UUID) */
  id: string;

  /** The bounty this claim is for (foreign key to bounties.id) */
  bountyId: string;

  /** The claimer's LNURL (withdrawal link) */
  claimantLnurl: string;

  /** Timestamp when the claim was submitted */
  claimedAt: Date;

  /** Current status of the claim */
  status: ClaimStatus;

  /** LNbits transaction ID for the payout (if approved & paid) */
  payoutTxid?: string;

  /** Pubkey or identifier of who approved the claim */
  approvedBy?: string;

  /** Timestamp when the claim was approved (null if not approved) */
  approvedAt?: Date;

  // Optional: link to the test item (if already loaded)
  testItem?: CustomTestItem;
}

export type ClaimStatus = 'pending' | 'approved';

export const claimStatusPending: ClaimStatus = 'pending';

export const claimStatusApproved: ClaimStatus = 'approved';
