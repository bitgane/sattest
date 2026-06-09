import * as vscode from 'vscode';
import { BountyInfo, claimStatusApproved, claimStatusPending } from './bounty.types.js';
import { findTestItemById } from '../test/test-item.util.js';

export class BountyCodeLensProvider implements vscode.CodeLensProvider {
  private bounties: Map<string, BountyInfo>;
  private onBountiesChangedEmitter: vscode.EventEmitter<void>;
  private userNostrPubkey: string | undefined;

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
    this.onBountiesChangedEmitter.event(() => {
      this._onDidChangeCodeLenses.fire();
    });
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
    for (const [testId, bounty] of this.bounties.entries()) {
      const item = findTestItemById(testId);

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
      const claimStatus = bounty.claims?.[0]?.status;
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
