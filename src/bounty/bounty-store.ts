import * as vscode from 'vscode';
import type { Event, EventTemplate } from 'nostr-tools/pure';
import { decode as nip19Decode } from 'nostr-tools/nip19';
import {
  BOUNTY_KIND,
  BountyEventStatus,
  CLAIM_KIND,
  MIN_CLAIM_POW,
  sattestAccountPubkey,
  TAG,
  parseCoordinate,
} from '../api/nostr-protocol.js';
import {
  BountyContent,
  assembleBounties,
  buildAnnouncement,
  buildBountyEvent,
  buildClaimEvent,
  decryptClaimLnurl,
  hasValidSignature,
  mineClaimPow,
  newBountyId,
  parseClaimEvent,
} from './bounty-events.js';
import { BountyInfo, BountyPayout, ClaimInfo } from './bounty.types.js';
import {
  describeRepoIdentityFailure,
  getRepoIdentity,
  RepoIdentity,
} from '../git/repo-identity.js';
import { RelayClient, PublishError } from '../nostr/relay-client.js';
import {
  approveAndPay,
  PayoutDeps,
  PayoutJournal,
  PayoutWallet,
  resolveHeldPayout,
  sweepJournal,
  KeyValueStore,
} from '../lightning/payout.js';
import { NwcClient } from '../lightning/nwc-client.js';
import { fetchInvoiceForAmount, fetchLnurlLimits } from '../lightning/lnurl-pay.js';
import { workspaceRoot } from '../test/test-item.util.js';
import { decryptForUser, signUserEvent } from '../api/user-signer.js';
import { SignerCancelledError } from '../api/signer-errors.js';

/**
 * Bounty storage on Nostr.
 *
 * The commands call the exported functions (`fetchBounties`, `createBounty`,
 * `approveClaim`, …). Underneath:
 *
 *  - reads are relay queries scoped by the repository id (`r` tag), validated
 *    and decrypted locally (`bounty-events.ts`);
 *  - writes are events signed by the user's own Nostr signer;
 *  - payouts run on this machine against the user's own wallet
 *    (`lightning/payout.ts`), never through a server.
 */

export interface StoreDeps {
  relays: RelayClient;
  identity: () => Promise<RepoIdentity | undefined>;
  sign: (template: EventTemplate, operation: string) => Promise<Event>;
  decrypt: (sender: string, ciphertext: string, operation: string) => Promise<string>;
  openWallet: () => Promise<PayoutWallet | undefined>;
  journalStore: KeyValueStore;
  fetchInvoice?: PayoutDeps['fetchInvoice'];
  lnurlLimits?: (lnurl: string) => Promise<{ minSendable: number; maxSendable: number }>;
  minClaimPow?: number;
  settleMs?: number;
  /** Prefix applied to stored (repo-relative) test ids for local display. */
  workspaceRoot?: () => string;
  /** Pubkey of the Sattest project account (announcements). */
  sattestPubkey?: string;
}

/** Result shapes the approve command already understands. */
export type ApproveClaimResult =
  | BountyInfo
  | 'already-approved'
  | 'in-progress'
  | 'outcome-unknown'
  | 'needs-confirmation'
  | 'claimant-changed'
  | null;

export interface FetchBountiesOptions {
  testIds?: string[];
  includeInactive?: boolean;
  /** Show an error notification when loading fails (default true). */
  notifyOnError?: boolean;
  /** Rethrow load failures instead of returning [] (callers that replace state). */
  throwOnError?: boolean;
}

interface CachedBounty {
  content: Omit<BountyContent, 'v'>;
  event: Event;
}

// Background loads fire in bursts; toast at most once per window.
let lastFetchErrorToastAt = 0;
const FETCH_ERROR_TOAST_COOLDOWN_MS = 10_000;
// The identity problem last surfaced by a background load. Shown once per
// distinct problem (not once per session), and cleared on success, so a fixed
// repository stops warning and a new problem is still reported.
let lastIdentityWarning: string | undefined;

/** Reset once-per-session notices. Test-only. */
export function _resetNoticesForTests(): void {
  lastFetchErrorToastAt = 0;
  lastIdentityWarning = undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class BountyStore {
  /** Decrypted content + newest event per bounty coordinate. */
  private readonly cache = new Map<string, CachedBounty>();
  private readonly journal: PayoutJournal;

  constructor(private readonly deps: StoreDeps) {
    this.journal = new PayoutJournal(deps.journalStore);
  }

  private root(): string {
    return this.deps.workspaceRoot?.() ?? '';
  }

  /** Repo-relative test id → the absolute form the Test Controller uses. */
  private toLocalTestId(testId: string): string {
    const root = this.root();
    if (!root) {
      return testId;
    }
    return testId.startsWith('/') ? root + testId : `${root}/${testId}`;
  }

  /** Absolute test id → the repo-relative form stored in events. */
  private toStoredTestId(testId: string): string {
    const root = this.root();
    return root && testId.startsWith(root) ? testId.slice(root.length) : testId;
  }

  private async requireIdentity(): Promise<RepoIdentity> {
    const identity = await this.deps.identity();
    if (!identity) {
      throw new Error('Sattest needs a git repository with at least one commit to manage bounties.');
    }
    return identity;
  }

  /** Every bounty + claim event in this repository, merged across relays. */
  private async loadEvents(identity: RepoIdentity, extra: Partial<{ coordinate: string }> = {}) {
    if (extra.coordinate) {
      const c = parseCoordinate(extra.coordinate)!;
      const [bounties, claims] = await Promise.all([
        this.deps.relays.query({ kinds: [BOUNTY_KIND], authors: [c.pubkey], '#d': [c.d] }),
        this.deps.relays.query({ kinds: [CLAIM_KIND], '#a': [extra.coordinate] }),
      ]);
      return [...bounties, ...claims];
    }
    return this.deps.relays.query({
      kinds: [BOUNTY_KIND, CLAIM_KIND],
      '#r': [identity.repoId],
    });
  }

  private assemble(identity: RepoIdentity, events: Event[]): BountyInfo[] {
    const list = assembleBounties(events, identity.repoKey, identity.repoId, {
      minClaimPow: this.deps.minClaimPow ?? MIN_CLAIM_POW,
    });
    for (const b of list) {
      const event = events.find((e) => e.id === b.eventId)!;
      this.cache.set(b.coordinate, {
        event,
        content: {
          testId: b.testId,
          testLabel: b.testLabel,
          amountSats: b.amountSats,
          repoSlug: b.repoSlug,
          memo: b.memo,
        },
      });
      b.testId = this.toLocalTestId(b.testId);
    }
    return list;
  }

  /** Load this repository's bounties (newest first). Never throws unless asked. */
  async fetchBounties(options: FetchBountiesOptions = {}): Promise<BountyInfo[]> {
    const { includeInactive = false, testIds, notifyOnError = true, throwOnError = false } = options;
    const identity = await this.deps.identity();
    if (!identity) {
      return [];
    }
    try {
      let list = this.assemble(identity, await this.loadEvents(identity));
      if (!includeInactive) {
        list = list.filter((b) => b.active);
      }
      if (testIds && testIds.length > 0) {
        const wanted = new Set(testIds.map((id) => this.toLocalTestId(id)));
        list = list.filter((b) => wanted.has(b.testId));
      }
      return list;
    } catch (error) {
      if (throwOnError) {
        throw error;
      }
      console.error('[fetchBounties] Error loading bounties from relays:', error);
      const now = Date.now();
      if (notifyOnError && now - lastFetchErrorToastAt > FETCH_ERROR_TOAST_COOLDOWN_MS) {
        lastFetchErrorToastAt = now;
        vscode.window.showErrorMessage('Failed to load bounties from Nostr relays');
      }
      return [];
    }
  }

  /** One bounty, fresh from relays. */
  async refetch(bounty: Pick<BountyInfo, 'coordinate'>): Promise<BountyInfo | undefined> {
    const identity = await this.requireIdentity();
    const events = await this.loadEvents(identity, { coordinate: bounty.coordinate });
    return this.assemble(identity, events).find((b) => b.coordinate === bounty.coordinate);
  }

  /** Live updates for this repository's bounties and claims. */
  async subscribe(onChange: () => void): Promise<{ close: () => void } | undefined> {
    const identity = await this.deps.identity();
    if (!identity) {
      return undefined;
    }
    return this.deps.relays.subscribe(
      {
        kinds: [BOUNTY_KIND, CLAIM_KIND],
        '#r': [identity.repoId],
        since: Math.floor(Date.now() / 1000) - 60,
      },
      (event) => {
        if (hasValidSignature(event)) {
          onChange();
        }
      }
    );
  }

  private async publishVersion(
    bounty: BountyInfo,
    status: BountyEventStatus,
    payout: BountyPayout | undefined,
    eventually: boolean
  ): Promise<BountyInfo> {
    const identity = await this.requireIdentity();
    let cached = this.cache.get(bounty.coordinate);
    if (!cached) {
      await this.refetch(bounty);
      cached = this.cache.get(bounty.coordinate);
    }
    if (!cached) {
      throw new Error('Bounty details are not available');
    }
    const template = buildBountyEvent({
      id: bounty.id,
      repoId: identity.repoId,
      repoKey: identity.repoKey,
      content: cached.content,
      status,
      payout,
      previousCreatedAt: Math.max(cached.event.created_at, bounty.eventCreatedAt),
    });
    const event = await this.deps.sign(template, `bounty ${status} update`);
    if (eventually) {
      await this.deps.relays.publishEventually(event);
    } else {
      await this.deps.relays.publish(event);
    }
    return this.assembleOne(identity, event, bounty);
  }

  private assembleOne(identity: RepoIdentity, event: Event, previous: BountyInfo): BountyInfo {
    // Claims don't change when the bounty does; reuse what we know.
    const [updated] = assembleBounties([event], identity.repoKey, identity.repoId);
    const content = this.cache.get(previous.coordinate)?.content;
    if (content) {
      this.cache.set(previous.coordinate, { content, event });
    }
    const status = updated.status;
    return {
      ...previous,
      eventId: event.id,
      eventCreatedAt: event.created_at,
      status,
      active: updated.active,
      payout: updated.payout,
      claims: previous.claims.map((c) => ({
        ...c,
        status:
          updated.payout?.claimantPubkey === c.claimantPubkey
            ? status === 'paid'
              ? 'approved'
              : status === 'approving'
                ? 'approving'
                : 'pending'
            : 'pending',
      })),
    };
  }

  /** Create and publish a bounty. Requires at least one relay to accept it. */
  async createBounty(input: {
    amountSats: number;
    testId: string;
    testLabel: string;
    repoSlug?: string;
    memo?: string;
  }): Promise<BountyInfo> {
    const identity = await this.requireIdentity();
    const content = {
      testId: this.toStoredTestId(input.testId),
      testLabel: input.testLabel,
      amountSats: input.amountSats,
      repoSlug: input.repoSlug,
      memo: input.memo,
    };
    const template = buildBountyEvent({
      id: newBountyId(),
      repoId: identity.repoId,
      repoKey: identity.repoKey,
      content,
      status: 'open',
    });
    const event = await this.deps.sign(template, 'bounty creation');
    await this.deps.relays.publish(event);
    const [created] = this.assemble(identity, [event]);
    return created;
  }

  /**
   * File (or update) the user's claim. The payout address is encrypted to the
   * bounty creator, and the claim carries proof of work so it isn't filtered
   * as spam.
   */
  async claimBounty(
    bounty: BountyInfo,
    lnurl: string,
    opts: { publicConsent?: boolean; claimantPubkey: string }
  ): Promise<ClaimInfo> {
    const identity = await this.requireIdentity();
    const previous = await this.deps.relays
      .query({ kinds: [CLAIM_KIND], authors: [opts.claimantPubkey], '#a': [bounty.coordinate] })
      .catch(() => [] as Event[]);
    const previousCreatedAt = previous.reduce((m, e) => Math.max(m, e.created_at), 0) || undefined;
    const template = mineClaimPow(
      buildClaimEvent({
        bountyCoordinate: bounty.coordinate,
        repoId: identity.repoId,
        lnurl,
        publicConsent: opts.publicConsent,
        previousCreatedAt,
      }),
      opts.claimantPubkey,
      this.deps.minClaimPow ?? MIN_CLAIM_POW
    );
    const event = await this.deps.sign(template, 'claim');
    // A signer that rewrites the event would throw the proof of work away.
    const parsed = parseClaimEvent(event, { minPow: this.deps.minClaimPow ?? MIN_CLAIM_POW });
    if (!parsed) {
      throw new Error(
        'Your signer changed the claim while signing it, so its anti-spam proof of work was lost.'
      );
    }
    const inbox = await this.deps.relays.inboxRelaysOf(bounty.creatorId);
    await this.deps.relays.publish(event, inbox);
    return {
      id: event.id,
      bountyId: bounty.id,
      claimantPubkey: event.pubkey,
      claimedAt: new Date(event.created_at * 1000),
      status: 'pending',
      encryptedLnurl: event.content,
      ephemeralPubkey: parsed.ephemeralPubkey,
      publicConsent: parsed.publicConsent,
    };
  }

  /** The bounty's open claims, fresh from relays (creator view). */
  async getPendingClaims(bounty: BountyInfo): Promise<ClaimInfo[]> {
    const fresh = await this.refetch(bounty).catch(() => undefined);
    return (fresh ?? bounty).claims.filter((c) => c.status !== 'approved');
  }

  /** Decrypt a claim's payout address for display; undefined when it can't. */
  async readClaimPayoutAddress(claim: ClaimInfo): Promise<string | undefined> {
    try {
      return await decryptClaimLnurl(claim, (sender, ct) =>
        this.deps.decrypt(sender, ct, 'reading the claim\'s payout address')
      );
    } catch (err) {
      console.warn('[readClaimPayoutAddress] could not decrypt:', err);
      return undefined;
    }
  }

  private payoutDeps(): PayoutDeps {
    return {
      journal: this.journal,
      openWallet: this.deps.openWallet,
      refetchBounty: (b) => this.refetch(b),
      publishStatus: (b, status, payout) => this.publishVersion(b, status, payout, false),
      publishStatusEventually: (b, status, payout) =>
        this.publishVersion(b, status, payout, true).catch(() => b),
      decryptLnurl: (claim) =>
        decryptClaimLnurl(claim, (sender, ct) =>
          this.deps.decrypt(sender, ct, 'reading the claim\'s payout address')
        ),
      fetchInvoice:
        this.deps.fetchInvoice ?? ((lnurl, msat, comment) => fetchInvoiceForAmount(lnurl, msat, comment)),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      settleMs: this.deps.settleMs,
    };
  }

  /** Approve `claim` and pay it from the connected wallet. */
  async approveClaim(bounty: BountyInfo, claim: ClaimInfo): Promise<ApproveClaimResult> {
    let outcome;
    try {
      outcome = await approveAndPay(this.payoutDeps(), bounty, claim);
    } catch (err) {
      if (err instanceof SignerCancelledError) {
        return null;
      }
      vscode.window.showErrorMessage(`Failed to approve claim: ${errorText(err)}`);
      return null;
    }
    switch (outcome.kind) {
      case 'paid':
        return outcome.bounty;
      case 'already-approved':
      case 'outcome-unknown':
        return outcome.kind;
      case 'in-progress':
        vscode.window.showInformationMessage(outcome.detail);
        return 'in-progress';
      case 'needs-confirmation':
        console.warn('[approveClaim] needs confirmation:', outcome.detail);
        return 'needs-confirmation';
      case 'claimant-changed':
        vscode.window.showWarningMessage(outcome.detail);
        return 'claimant-changed';
      case 'error':
        vscode.window.showErrorMessage(outcome.message);
        return null;
    }
  }

  /** The creator's verdict on a payout no wallet can report on. */
  async resolveHeldClaim(bounty: BountyInfo, outcome: 'paid' | 'not-paid'): Promise<boolean> {
    try {
      return await resolveHeldPayout(this.payoutDeps(), bounty, outcome);
    } catch (err) {
      if (!(err instanceof SignerCancelledError)) {
        vscode.window.showErrorMessage(`Failed to resolve claim: ${errorText(err)}`);
      }
      return false;
    }
  }

  /** Remove (cancel) a bounty. No refunds: nothing was ever held. */
  async deactivateBounty(bounty: BountyInfo): Promise<boolean> {
    const held = this.journal.get(bounty.coordinate);
    if (held && held.state !== 'paid') {
      vscode.window.showWarningMessage(
        'This bounty has a payout in progress. Re-check it from the "Payout Processing" lens first.'
      );
      return false;
    }
    if (bounty.status === 'paid' || bounty.status === 'cancelled') {
      return true; // already closed — nothing to publish
    }
    try {
      await this.publishVersion(bounty, 'cancelled', undefined, false);
      return true;
    } catch (err) {
      if (!(err instanceof SignerCancelledError)) {
        vscode.window.showErrorMessage(`Failed to remove bounty: ${errorText(err)}`);
      }
      return false;
    }
  }

  /**
   * Publish an opt-in public announcement tagging the Sattest account. Only
   * ever called after the user agreed to make these details public.
   */
  async announce(
    bounty: BountyInfo,
    kind: 'bounty' | 'payout',
    claimantPubkey?: string
  ): Promise<boolean> {
    const sattestPubkey = this.deps.sattestPubkey ?? sattestAccountPubkey();
    if (!sattestPubkey) {
      return false;
    }
    const template = buildAnnouncement({
      kind,
      bountyCoordinate: bounty.coordinate,
      amountSats: bounty.amountSats,
      testLabel: bounty.testLabel ?? 'a test',
      repoSlug: bounty.repoSlug,
      sattestPubkey,
      claimantPubkey,
    });
    try {
      const event = await this.deps.sign(template, 'public announcement');
      await this.deps.relays.publish(event);
      return true;
    } catch (err) {
      console.warn('[announce] skipped:', err);
      return false;
    }
  }

  /** Pre-check a payout address's sendable range; null when unknown. */
  async getLnurlLimits(lnurl: string): Promise<{ minSendable: number; maxSendable: number } | null> {
    try {
      return await (this.deps.lnurlLimits ?? fetchLnurlLimits)(lnurl.trim());
    } catch {
      return null;
    }
  }

  /**
   * Activation housekeeping: retry unsent events, settle held payouts, and
   * re-broadcast the user's own open bounties so relays that lost them get
   * them back. Never throws.
   */
  async housekeeping(userPubkey: string | undefined): Promise<void> {
    try {
      await this.deps.relays.flushOutbox();
      await sweepJournal(this.payoutDeps(), (coordinate) => this.refetch({ coordinate }));
      if (userPubkey) {
        const identity = await this.deps.identity();
        if (identity) {
          const mine = (await this.loadEvents(identity)).filter(
            (e) =>
              e.pubkey === userPubkey &&
              (e.kind === BOUNTY_KIND || e.kind === CLAIM_KIND) &&
              e.tags.some((t) => t[0] === TAG.repo && t[1] === identity.repoId)
          );
          await this.deps.relays.rebroadcast(mine);
        }
      }
    } catch (err) {
      console.warn('[housekeeping] skipped:', err);
    }
  }
}

/**
 * Order bounties so the one shown for a test is the most trustworthy: the
 * user's own, then trusted creators', then the newest. A stranger posting a
 * newer bounty on the same test must not displace a maintainer's.
 */
export function rankBounties(
  bounties: BountyInfo[],
  me: string | undefined,
  trusted: string[]
): BountyInfo[] {
  const trustedHex = new Set(
    trusted
      .map((t) => {
        const v = t.trim();
        if (/^[0-9a-f]{64}$/i.test(v)) {
          return v.toLowerCase();
        }
        try {
          const decoded = nip19Decode(v);
          return decoded.type === 'npub' ? (decoded.data as string) : undefined;
        } catch {
          return undefined;
        }
      })
      .filter((v): v is string => !!v)
  );
  const rank = (b: BountyInfo) => (b.creatorId === me ? 0 : trustedHex.has(b.creatorId) ? 1 : 2);
  return [...bounties].sort(
    (a, b) => rank(a) - rank(b) || b.eventCreatedAt - a.eventCreatedAt
  );
}

// --- Module-level instance used by the commands ---------------------------------

let store: BountyStore | undefined;
let relayClient: RelayClient | undefined;

/** Build the default store (called once from activate). */
export function initBountyStore(opts: {
  relays: () => string[];
  globalState: KeyValueStore;
  getNwcUri: () => Promise<string | undefined>;
}): BountyStore {
  relayClient?.close();
  relayClient = new RelayClient(opts.relays, { store: opts.globalState });
  store = new BountyStore({
    relays: relayClient,
    identity: async () => {
      const r = await getRepoIdentity();
      if (!r.ok) {
        const message = describeRepoIdentityFailure(r.reason, r.detail);
        if (message !== lastIdentityWarning) {
          lastIdentityWarning = message;
          vscode.window.showInformationMessage(message);
        }
        return undefined;
      }
      lastIdentityWarning = undefined;
      return r;
    },
    sign: (t, op) => signUserEvent(t, op),
    decrypt: (sender, ct, op) => decryptForUser(sender, ct, op),
    openWallet: async () => {
      const uri = await opts.getNwcUri();
      return uri ? new NwcClient(uri) : undefined;
    },
    journalStore: opts.globalState,
    workspaceRoot,
  });
  return store;
}

/** Install a store directly. Test-only. */
export function _setBountyStoreForTests(s: BountyStore | undefined): void {
  store = s;
}

export function disposeBountyStore(): void {
  relayClient?.close();
  relayClient = undefined;
  store = undefined;
}

function requireStore(): BountyStore {
  if (!store) {
    throw new Error('Bounty store not initialised');
  }
  return store;
}

export const fetchBounties = (o?: FetchBountiesOptions) =>
  store ? store.fetchBounties(o) : Promise.resolve([] as BountyInfo[]);
export const createBounty = (i: Parameters<BountyStore['createBounty']>[0]) =>
  requireStore().createBounty(i);
export const claimBounty = (...a: Parameters<BountyStore['claimBounty']>) =>
  requireStore().claimBounty(...a);
export const getPendingClaims = (b: BountyInfo) => requireStore().getPendingClaims(b);
export const approveClaim = (b: BountyInfo, c: ClaimInfo) => requireStore().approveClaim(b, c);
export const readClaimPayoutAddress = (c: ClaimInfo) =>
  store ? store.readClaimPayoutAddress(c) : Promise.resolve(undefined);
export const resolveHeldClaim = (b: BountyInfo, o: 'paid' | 'not-paid') =>
  requireStore().resolveHeldClaim(b, o);
export const deactivateBounty = (b: BountyInfo) => requireStore().deactivateBounty(b);
export const announceBounty = (...a: Parameters<BountyStore['announce']>) =>
  store ? store.announce(...a) : Promise.resolve(false);
export const getLnurlLimits = (lnurl: string) =>
  store ? store.getLnurlLimits(lnurl) : Promise.resolve(null);

export { PublishError };
