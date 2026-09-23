import * as vscode from 'vscode';
import {
  BountyInfo,
  ClaimInfo,
  ClaimStatus,
  claimStatusApproved,
  claimStatusApproving,
  claimStatusPending,
} from './bounty.types.js';
import { buildTestItemIndex, findTestItemById, testIdFilePath } from '../test/test-item.util.js';

/** POSIX ("/a/b") or Windows ("C:\\a\\b") absolute path, as `Uri.fsPath` yields. */
function isAbsolutePathLike(value: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\/)/.test(value);
}

/**
 * The claim state the lens should display for a bounty.
 *
 * A bounty can carry several open claims — the backend deliberately returns all
 * of them so the creator chooses whom to pay — so `claims[0]` is not "the
 * bounty's state", it is merely whichever claim was filed most recently, and
 * that ordering is attacker-influenced. Reading it directly meant a bounty whose
 * payout was already in flight still rendered "Claim Pending" (and offered
 * Approve) as soon as anyone filed a newer claim.
 *
 * Collapse the set by how far it has progressed instead: an approved claim means
 * the bounty is paid, an approving one means a payout is in flight and nothing
 * else may be offered, and only then does a pending claim decide the lens.
 */
export function aggregateClaimStatus(
  claims: ClaimInfo[] | undefined
): ClaimStatus | undefined {
  if (!claims || claims.length === 0) {
    return undefined;
  }
  const statuses = new Set(claims.map((c) => c.status));
  if (statuses.has(claimStatusApproved)) {
    return claimStatusApproved;
  }
  if (statuses.has(claimStatusApproving)) {
    return claimStatusApproving;
  }
  if (statuses.has(claimStatusPending)) {
    return claimStatusPending;
  }
  return undefined;
}

export class BountyCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private bounties: Map<string, BountyInfo>;
  private onBountiesChangedEmitter: vscode.EventEmitter<void>;
  private userNostrPubkey: string | undefined;
  private changeSubscription: vscode.Disposable;

  // Event emitter for CodeLens refresh
  public _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

  constructor(
    bounties: Map<string, BountyInfo>,
    onBountiesChangedEmitter: vscode.EventEmitter<void>,
    userNostrPubkey: string | undefined
  ) {
    this.bounties = bounties;
    this.onBountiesChangedEmitter = onBountiesChangedEmitter;
    this.userNostrPubkey = userNostrPubkey;

    // Listen to bounty changes → trigger CodeLens refresh
    this.changeSubscription = this.onBountiesChangedEmitter.event(() => {
      this._onDidChangeCodeLenses.fire();
    });
  }

  /** Release the change listener and refresh emitter when the extension unloads. */
  dispose() {
    this.changeSubscription.dispose();
    this._onDidChangeCodeLenses.dispose();
  }

  /**
   * Update the Nostr pubkey used to decide whether to render the creator-only
   * "Approve Claim" lens. Called when the user connects to Nostr after the
   * extension has already activated — without this, the lens would forever
   * see `undefined` and the creator could only approve via the right-click
   * menu.
   */
  setUserNostrPubkey(pubkey: string | undefined) {
    if (this.userNostrPubkey === pubkey) {
      return;
    }
    this.userNostrPubkey = pubkey;
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(
    document: vscode.TextDocument
  ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
    const lenses: vscode.CodeLens[] = [];

    // Bounties that cannot belong to this document are rejected on a string
    // compare, before any test item is resolved. VS Code calls this on open, on
    // edit, on scroll and on every refresh fire, so the common case — a file
    // holding none of the workspace's bounties — must not cost a lookup each.
    const documentPath = document.uri.fsPath;
    const candidates = [...this.bounties.entries()].filter(([testId]) => {
      const testPath = testIdFilePath(testId);
      // Only skip on an id that actually carries an absolute workspace path —
      // the shape `normalizedTestId` produces. Any other id (a bare label, a
      // relative path) falls through to the authoritative uri check below, so an
      // unrecognised id costs a lookup rather than silently losing its lens.
      if (!isAbsolutePathLike(testPath)) {
        return true;
      }
      return testPath === documentPath;
    });

    if (candidates.length === 0) {
      return lenses;
    }

    // One tree walk for the whole render rather than one per bounty.
    const testItemIndex = buildTestItemIndex();

    for (const [testId, bounty] of candidates) {
      const item = findTestItemById(testId, testItemIndex);

      if (!item) {
        continue;
      }
      if (item.uri?.toString() !== document.uri.toString()) {
        continue;
      }
      if (!bounty.active) {
        continue;
      }
      // Some lazily-resolved test items don't have a range yet (e.g. they were
      // discovered from a folder watcher before the file was parsed). Anchor
      // the lens at the top of the document so the user still sees it.
      const effectiveRange = item.range ?? new vscode.Range(0, 0, 0, 0);

      let title = '';
      let command = '';
      let tooltip = '';
      const claimStatus = aggregateClaimStatus(bounty.claims);
      const isNwc = bounty.fundingMode === 'nwc';
      // Tag non-custodial bounties so the creator and potential claimers can
      // see at a glance that sats live in the creator's own wallet, not our
      // LNbits host.
      const badge = isNwc ? ' · Non-custodial' : '';

      if (claimStatus === claimStatusPending) {
        title = `💰 Claim Pending (${bounty.amountSats} sats)${badge}`;
        // No action wired up — the lens is purely informational here. The
        // creator approves via the dedicated "✅ Approve Claim" lens that
        // renders below this one for them.
        command = '';
        tooltip =
          this.userNostrPubkey && bounty.creatorId === this.userNostrPubkey
            ? 'Use the Approve Claim action below to release the payout'
            : 'Waiting for the creator to approve your claim';
      } else if (claimStatus === claimStatusApproving) {
        // Payout is mid-flight (claim locked, Lightning payment settling), or
        // the outcome of an earlier attempt was never confirmed and the claim
        // is being held so it can't be paid twice.
        //
        // The claimant gets a purely informational lens — they must not be able
        // to re-claim or approve during the window. The creator gets a way back
        // in: clicking asks their wallet what actually happened (the backend
        // reconciles before it will pay anything), which is the only route out
        // of a held claim short of an operator running SQL.
        const isCreator =
          !!this.userNostrPubkey && bounty.creatorId === this.userNostrPubkey;
        title = `💸 Payout Processing (${bounty.amountSats} sats)${badge}`;
        command = isCreator ? 'sattest.approveClaim' : '';
        tooltip = isCreator
          ? 'Payout in progress. If it seems stuck, click to re-check it with your wallet — Sattest only sends again if your wallet confirms the payment did not go through.'
          : 'Payout in progress — waiting for the Lightning payment to settle';
      } else if (claimStatus === claimStatusApproved) {
        title = `💰 Claim Approved – Payout Sent (${bounty.amountSats} sats)${badge}`;
      } else if (bounty.invoicePaid) {
        title = `💰 Funded – Claimable (${bounty.amountSats} sats)${badge}`;
        command = 'sattest.claimBounty';
        tooltip = isNwc
          ? 'Click to claim bounty payout (non-custodial — funded from creator wallet on approval)'
          : 'Click to claim bounty payout';
      } else if (bounty.paymentHash) {
        title = `💰 Awaiting Funding (${bounty.amountSats} sats)`;
        command = 'sattest.checkPaid';
        tooltip = 'Check if bounty has been funded';
      } else {
        // NWC bounties with invoicePaid=false shouldn't happen (backend sets
        // it true on creation) but guard anyway so we don't render a broken
        // "Awaiting Funding" lens that polls a non-existent paymentHash.
        continue;
      }

      const lens = new vscode.CodeLens(effectiveRange, {
        title,
        command,
        arguments: [item],
        tooltip,
      });

      lenses.push(lens);

      if (
        claimStatus === claimStatusPending &&
        bounty.creatorId &&
        this.userNostrPubkey &&
        bounty.creatorId === this.userNostrPubkey
      ) {
        lenses.push(
          new vscode.CodeLens(effectiveRange, {
            title: '✅ Approve Claim',
            command: 'sattest.approveClaim',
            // The command handler expects a TestItem (it reads `test.id` to
            // look up the bounty). Passing `[testId, item]` here used to
            // hand a string in as the first arg and the handler bailed with
            // "No test selected". Match the shape the other lenses use.
            arguments: [item],
            tooltip: `Approve claim of ${bounty.amountSats} sats`,
          })
        );
      }

      if (
        (bounty.active && !bounty.invoicePaid) ||
        bounty.creatorId === this.userNostrPubkey
      ) {
        // Once the claim is approved (payout sent), label the lens "Remove
        // Paid Bounty" so the creator knows this one is already complete —
        // removing it frees the test for a fresh bounty later.
        const isPaid = claimStatus === claimStatusApproved;
        const removeLens = new vscode.CodeLens(effectiveRange, {
          title: isPaid ? '🗑️ Remove Paid Bounty' : '🗑️ Remove Bounty',
          command: 'sattest.removeBounty',
          arguments: [item],
          tooltip: `Remove ${bounty.amountSats} sats bounty for this test`,
        });
        lenses.push(removeLens);
      }
    }

    return lenses;
  }

  resolveCodeLens?(
    codeLens: vscode.CodeLens,
    _token: vscode.CancellationToken
  ): vscode.CodeLens | Thenable<vscode.CodeLens> | undefined {
    return codeLens;
  }
}
