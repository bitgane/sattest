import type { BountyInfo, BountyPayout, ClaimInfo } from '../bounty/bounty.types.js';
import type { BountyEventStatus } from '../api/nostr-protocol.js';
import { RESOLUTION_CREATOR_CONFIRMED } from '../api/nostr-protocol.js';
import { decodeInvoice } from './bolt11.js';
import type { NwcPaymentLookup } from './nwc-client.js';
import { NwcPayoutError, NwcWalletError, describeWalletRefusal } from './nwc-client.js';

/**
 * The payout state machine, run on the bounty creator's machine.
 *
 * There is no database to make "pay this claim" happen at most once, so the
 * guarantee is built from three pieces:
 *
 *  1. A local write-ahead journal (VS Code globalState). The journal entry —
 *     including the exact bolt11 and its payment hash — is written BEFORE the
 *     wallet is asked to pay, so a crash, a reload or a second click always
 *     finds it and reconciles instead of paying again.
 *  2. A public `approving` status, published (and accepted by at least one
 *     relay) before paying. If it can't be published, nothing is paid. Other
 *     devices of the same creator see it and refuse to pay blind.
 *  3. The payment hash as the idempotency key. An attempt whose outcome is
 *     unknown is settled by asking the same wallet about the same hash
 *     (`lookup_invoice`) — never by minting a new invoice and paying again.
 *
 * Every dependency is injected, so the whole machine is testable without
 * relays, a signer or a wallet.
 */

export const PAYOUT_JOURNAL_KEY = 'sattest.payoutJournal';

/**
 * - `locking`: journal written, `approving` status not yet confirmed on any
 *   relay. The wallet has NOT been asked to pay.
 * - `approving`: the wallet has been (or is about to be) asked to pay.
 * - `paid`: settled; kept for a while as a record.
 */
export type JournalState = 'locking' | 'approving' | 'paid';

export interface JournalEntry {
  bountyCoordinate: string;
  bountyId: string;
  claimEventId: string;
  claimantPubkey: string;
  amountSats: number;
  bolt11: string;
  paymentHash: string;
  walletPubkey: string;
  state: JournalState;
  startedAt: number;
  preimage?: string;
}

/** Persistent key-value store — VS Code's `globalState` satisfies it. */
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export class PayoutJournal {
  constructor(private readonly store: KeyValueStore) {}

  all(): Record<string, JournalEntry> {
    return { ...(this.store.get<Record<string, JournalEntry>>(PAYOUT_JOURNAL_KEY) ?? {}) };
  }

  get(bountyCoordinate: string): JournalEntry | undefined {
    return this.all()[bountyCoordinate];
  }

  async put(entry: JournalEntry): Promise<void> {
    const all = this.all();
    all[entry.bountyCoordinate] = entry;
    await this.store.update(PAYOUT_JOURNAL_KEY, all);
  }

  async remove(bountyCoordinate: string): Promise<void> {
    const all = this.all();
    delete all[bountyCoordinate];
    await this.store.update(PAYOUT_JOURNAL_KEY, all);
  }
}

/** The wallet operations a payout needs (an `NwcClient`, or a fake). */
export interface PayoutWallet {
  readonly walletPubkey: string;
  /** The wallet service's domain, used only to explain refusals. */
  readonly walletDomain?: string;
  payInvoice(bolt11: string, expectedAmountSats: number): Promise<{ preimage: string }>;
  lookupPayment(ref: { paymentHash?: string; bolt11?: string }): Promise<NwcPaymentLookup>;
  close(): void;
}

export interface PayoutDeps {
  journal: PayoutJournal;
  /** The creator's connected wallet, or undefined when none is connected. */
  openWallet(): Promise<PayoutWallet | undefined>;
  /** Fresh copy of the bounty from relays; undefined when it can't be found. */
  refetchBounty(bounty: BountyInfo): Promise<BountyInfo | undefined>;
  /**
   * Publish a new version of the bounty. Must reject unless at least one
   * relay accepted it. Returns the updated bounty.
   */
  publishStatus(
    bounty: BountyInfo,
    status: BountyEventStatus,
    payout?: BountyPayout
  ): Promise<BountyInfo>;
  /** Like publishStatus, but a failure queues a retry instead of throwing. */
  publishStatusEventually(
    bounty: BountyInfo,
    status: BountyEventStatus,
    payout?: BountyPayout
  ): Promise<BountyInfo>;
  /** Decrypt the claim's payout address (the creator's signer). */
  decryptLnurl(claim: ClaimInfo): Promise<string>;
  /** LNURL → bolt11 for exactly `amountMsat`, amount cross-checked. */
  fetchInvoice(lnurl: string, amountMsat: number, comment: string): Promise<string>;
  sleep(ms: number): Promise<void>;
  /** How long to wait for a competing device's `approving` to show up. */
  settleMs?: number;
  now?: () => number;
}

export type ApproveOutcome =
  | { kind: 'paid'; bounty: BountyInfo; preimage: string }
  | { kind: 'already-approved' }
  | { kind: 'in-progress'; detail: string }
  | { kind: 'outcome-unknown' }
  | { kind: 'needs-confirmation'; detail: string }
  | { kind: 'claimant-changed'; detail: string }
  | { kind: 'error'; message: string };

const SETTLE_MS = 2_000;

function payoutFrom(entry: JournalEntry, extra: Partial<BountyPayout> = {}): BountyPayout {
  return {
    claimEventId: entry.claimEventId,
    claimantPubkey: entry.claimantPubkey,
    paymentHash: entry.paymentHash,
    ...extra,
  };
}

/**
 * Settle a journal entry whose payment may or may not have happened, by asking
 * the wallet that made the attempt.
 */
async function reconcile(
  deps: PayoutDeps,
  bounty: BountyInfo,
  entry: JournalEntry
): Promise<'settled' | 'released' | ApproveOutcome> {
  if (entry.state === 'paid') {
    // Paid locally, but the receipt never made it to a relay. Publish it now.
    await finalizePaid(deps, bounty, entry, entry.preimage ?? 'unknown-preimage');
    return 'settled';
  }
  if (entry.state === 'locking') {
    // The `approving` status was never confirmed, so the wallet was never
    // asked to pay. Nothing to reconcile — just drop the stale lock.
    await deps.journal.remove(entry.bountyCoordinate);
    return 'released';
  }
  const wallet = await deps.openWallet();
  if (!wallet) {
    return {
      kind: 'in-progress',
      detail: 'Reconnect your Lightning wallet so Sattest can confirm the previous payout.',
    };
  }
  try {
    // Only the wallet that made the attempt can say what happened to it. A
    // different wallet has never seen this payment hash: its "not found" — or
    // even "failed" — is not evidence, and trusting it could pay twice.
    if (wallet.walletPubkey !== entry.walletPubkey) {
      return {
        kind: 'needs-confirmation',
        detail:
          'The wallet now connected is not the one this payout was sent from, so Sattest ' +
          'cannot confirm what happened to it.',
      };
    }
    const lookup = await wallet.lookupPayment({
      paymentHash: entry.paymentHash,
      bolt11: entry.bolt11,
    });
    if (lookup.state === 'settled') {
      await finalizePaid(deps, bounty, entry, lookup.preimage);
      return 'settled';
    }
    if (lookup.state === 'failed') {
      await release(deps, bounty, entry);
      return 'released';
    }
    return {
      kind: 'in-progress',
      detail:
        lookup.state === 'pending'
          ? 'The Lightning payment is still settling.'
          : 'Sattest could not confirm the previous payout with your wallet yet.',
    };
  } finally {
    wallet.close();
  }
}

async function finalizePaid(
  deps: PayoutDeps,
  bounty: BountyInfo,
  entry: JournalEntry,
  preimage: string,
  resolution?: string
): Promise<BountyInfo> {
  const paidAt = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  // Journal first: money has moved, so the local record must say so even if
  // publishing the receipt has to be retried later.
  await deps.journal.put({ ...entry, state: 'paid', preimage });
  return deps.publishStatusEventually(
    bounty,
    'paid',
    payoutFrom(entry, {
      preimage: preimage === 'unknown-preimage' ? undefined : preimage,
      paidAt,
      resolution,
    })
  );
}

async function release(deps: PayoutDeps, bounty: BountyInfo, entry: JournalEntry): Promise<void> {
  await deps.journal.remove(entry.bountyCoordinate);
  if (bounty.status === 'approving') {
    await deps.publishStatusEventually(bounty, 'open');
  }
}

/**
 * Approve `claim` on `bounty` and pay it from the creator's wallet.
 * `claim` must be the exact claim the creator reviewed.
 */
export async function approveAndPay(
  deps: PayoutDeps,
  bounty: BountyInfo,
  claim: ClaimInfo
): Promise<ApproveOutcome> {
  // 1. Work from the network's current view, not a cached listing.
  let fresh: BountyInfo | undefined;
  try {
    fresh = await deps.refetchBounty(bounty);
  } catch (err) {
    return { kind: 'error', message: `Couldn't reach any relay: ${String(err)}` };
  }
  if (!fresh) {
    return { kind: 'error', message: 'This bounty could not be found on any relay.' };
  }
  if (fresh.status === 'paid') {
    return { kind: 'already-approved' };
  }
  if (fresh.status === 'cancelled') {
    return { kind: 'error', message: 'This bounty was removed and can no longer be paid out.' };
  }

  // 2. Settle any earlier attempt before doing anything new.
  const entry = deps.journal.get(fresh.coordinate);
  if (fresh.status === 'approving' || entry) {
    if (!entry || (fresh.status === 'approving' && fresh.payout?.paymentHash !== entry.paymentHash)) {
      // Another device started this payout; this machine has no record of the
      // attempt, so it can't ask any wallet about it.
      return {
        kind: 'needs-confirmation',
        detail:
          'A payout for this bounty was started on another device, so Sattest on this ' +
          'machine cannot confirm what happened to it.',
      };
    }
    const result = await reconcile(deps, fresh, entry);
    if (result === 'settled') {
      return { kind: 'already-approved' };
    }
    if (result !== 'released') {
      return result;
    }
    fresh = { ...fresh, status: 'open', payout: undefined };
  }

  // 3. The claim must be exactly the one the creator reviewed. A newer version
  //    (say, a changed payout address) means they have to look again.
  const current = fresh.claims.find((c) => c.claimantPubkey === claim.claimantPubkey);
  if (!current || current.id !== claim.id) {
    return {
      kind: 'claimant-changed',
      detail: 'This claim changed after you reviewed it. Review the claims again before paying.',
    };
  }

  const wallet = await deps.openWallet();
  if (!wallet) {
    return { kind: 'error', message: 'Connect your Lightning wallet (NWC) to pay this bounty.' };
  }
  try {
    // 4. Resolve everything that can fail before taking the lock.
    let bolt11: string;
    let paymentHash: string;
    let lnurl: string;
    try {
      lnurl = await deps.decryptLnurl(current);
      bolt11 = await deps.fetchInvoice(lnurl, fresh.amountSats * 1000, `bounty:${fresh.id}`);
      paymentHash = decodeInvoice(bolt11).paymentHash;
    } catch (err) {
      return {
        kind: 'error',
        message: `Couldn't get an invoice from the claimant's Lightning address: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    const newEntry: JournalEntry = {
      bountyCoordinate: fresh.coordinate,
      bountyId: fresh.id,
      claimEventId: current.id,
      claimantPubkey: current.claimantPubkey,
      amountSats: fresh.amountSats,
      bolt11,
      paymentHash,
      walletPubkey: wallet.walletPubkey,
      state: 'locking',
      startedAt: deps.now?.() ?? Date.now(),
    };

    // 5. Take the lock: journal first, then the public `approving` status. If
    //    no relay accepts it, nothing is paid.
    await deps.journal.put(newEntry);
    let locked: BountyInfo;
    try {
      locked = await deps.publishStatus(fresh, 'approving', payoutFrom(newEntry));
    } catch (err) {
      await deps.journal.remove(newEntry.bountyCoordinate);
      return {
        kind: 'error',
        message:
          'Couldn\'t record the payout on any Nostr relay, so nothing was paid. ' +
          `Check your connection and try again. (${err instanceof Error ? err.message : String(err)})`,
      };
    }
    await deps.journal.put({ ...newEntry, state: 'approving' });

    // 6. Another device of this creator may have raced us. The newest version
    //    wins; if it isn't ours, stand down before any money moves.
    await deps.sleep(deps.settleMs ?? SETTLE_MS);
    const raced = await deps.refetchBounty(locked).catch(() => undefined);
    if (raced && raced.payout?.paymentHash && raced.payout.paymentHash !== paymentHash) {
      await deps.journal.remove(newEntry.bountyCoordinate);
      return {
        kind: 'in-progress',
        detail: 'Another device started paying this bounty at the same moment.',
      };
    }

    // 7. Pay.
    let preimage: string;
    try {
      ({ preimage } = await wallet.payInvoice(bolt11, fresh.amountSats));
    } catch (err) {
      if (err instanceof NwcPayoutError && err.outcome === 'failed') {
        await release(deps, locked, { ...newEntry, state: 'approving' });
        const reason =
          err.cause instanceof NwcWalletError
            ? describeWalletRefusal(err.cause.code, err.cause.walletMessage, {
                claimantAddress: lnurl,
                walletDomain: wallet.walletDomain,
              })
            : err.message;
        return {
          kind: 'error',
          message:
            `Payout failed: ${reason} Nothing was sent — the claim is still open, so you can ` +
            'approve it again once this is fixed.',
        };
      }
      // Unknown: the wallet may have paid. Keep the lock; the next approve (or
      // the activation sweep) asks the wallet what happened.
      return { kind: 'outcome-unknown' };
    }

    const paid = await finalizePaid(deps, locked, { ...newEntry, state: 'approving' }, preimage);
    return { kind: 'paid', bounty: paid, preimage };
  } finally {
    wallet.close();
  }
}

/**
 * The creator's own verdict on a payout no wallet can report on (the attempt
 * was made from a wallet that is no longer connected, or another device).
 */
export async function resolveHeldPayout(
  deps: PayoutDeps,
  bounty: BountyInfo,
  outcome: 'paid' | 'not-paid'
): Promise<boolean> {
  const fresh = (await deps.refetchBounty(bounty).catch(() => undefined)) ?? bounty;
  const entry = deps.journal.get(fresh.coordinate);
  if (outcome === 'paid') {
    const record: JournalEntry =
      entry ??
      ({
        bountyCoordinate: fresh.coordinate,
        bountyId: fresh.id,
        claimEventId: fresh.payout?.claimEventId ?? '',
        claimantPubkey: fresh.payout?.claimantPubkey ?? '',
        amountSats: fresh.amountSats,
        bolt11: '',
        paymentHash: fresh.payout?.paymentHash ?? '',
        walletPubkey: '',
        state: 'approving',
        startedAt: Date.now(),
      } satisfies JournalEntry);
    // No preimage: this is the creator's word, recorded as such.
    await deps.journal.put({ ...record, state: 'paid' });
    await deps.publishStatus(fresh, 'paid', {
      ...payoutFrom(record),
      paidAt: Math.floor((deps.now?.() ?? Date.now()) / 1000),
      resolution: RESOLUTION_CREATOR_CONFIRMED,
    });
    return true;
  }
  await deps.journal.remove(fresh.coordinate);
  await deps.publishStatus(fresh, 'open');
  return true;
}

/** How long a finished payout stays in the journal as a local record. */
const PAID_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Activation sweep: drop stale `locking` entries (nothing was paid), try to
 * settle held `approving` ones, and prune old records. Never throws.
 */
export async function sweepJournal(
  deps: PayoutDeps,
  findBounty: (coordinate: string) => Promise<BountyInfo | undefined>
): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  for (const entry of Object.values(deps.journal.all())) {
    try {
      if (entry.state === 'paid') {
        if (now - entry.startedAt > PAID_RETENTION_MS) {
          await deps.journal.remove(entry.bountyCoordinate);
        }
        continue;
      }
      const bounty = await findBounty(entry.bountyCoordinate);
      if (!bounty) {
        continue;
      }
      await reconcile(deps, bounty, entry);
    } catch (err) {
      console.warn('[payout] sweep skipped an entry:', err);
    }
  }
}
