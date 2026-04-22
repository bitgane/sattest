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
      if (process.env.NODE_ENV === 'development') {
      }
      this._onDidChangeCodeLenses.fire();
    });
  }

  provideCodeLenses(
    document: vscode.TextDocument
  ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
    const lenses: vscode.CodeLens[] = [];
    let foundAny = false;
    for (const [testId, bounty] of this.bounties.entries()) {
      let item = findTestItemById(testId);

      if (!item) {
        continue;
      }
      if (item.uri?.toString() !== document.uri.toString()) {
        continue;
      }
      if (!bounty.active) {
        continue;
      }
      if (!item.range) {
      }
      const effectiveRange = item.range ?? new vscode.Range(0, 0, 0, 0);

      foundAny = true;

      let title = '';
      let command = '';
      let tooltip = '';
      const claimStatus = bounty.claims?.[0]?.status;

      if (claimStatus === claimStatusPending) {
        title = `💰 Claim Pending (${bounty.amountSats} sats)`;
        command = ''; // add a "View Claim Status" command later
        tooltip = 'Waiting for creator approval';
      } else if (claimStatus === claimStatusApproved) {
        title = `💰 Claim Approved – Payout Sent (${bounty.amountSats} sats)`;
      } else if (bounty.invoicePaid) {
        title = `💰 Funded – Claimable (${bounty.amountSats} sats)`;
        command = 'sattest.claimBounty';
        tooltip = 'Click to claim bounty payout';
      } else if (bounty.paymentHash) {
        title = `💰 Awaiting Funding (${bounty.amountSats} sats)`;
        command = 'sattest.checkPaid';
        tooltip = 'Check if bounty has been funded';
      } else {
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
            arguments: [testId, item],
            tooltip: `Approve claim of ${bounty.amountSats} sats`,
          })
        );
      }

      if (!bounty.active) {
        const addLens = new vscode.CodeLens(effectiveRange, {
          title: '➕ Add Bounty',
          command: 'sattest.addBounty',
          arguments: [item],
          tooltip: 'Add a Lightning bounty to this test',
        });
        lenses.push(addLens);
      }

      if (
        (bounty && bounty.active && !bounty.invoicePaid) ||
        bounty.creatorId === this.userNostrPubkey
      ) {
        const removeLens = new vscode.CodeLens(effectiveRange, {
          title: '🗑️ Remove Bounty',
          command: 'sattest.removeBounty',
          arguments: [item],
          tooltip: `Remove ${bounty.amountSats} sats bounty for this test`,
        });
        lenses.push(removeLens);
      }
    }

    if (!foundAny) {
      if (process.env.NODE_ENV === 'development') {
        console.debug('[BountyCodeLens] No lenses generated for:', document.uri.fsPath);
      }
    }
    return lenses;
  }

  resolveCodeLens?(
    codeLens: vscode.CodeLens,
    token: vscode.CancellationToken
  ): vscode.CodeLens | Thenable<vscode.CodeLens> | undefined {
    return codeLens;
  }

  private collectChildren(item: vscode.TestItem, items: vscode.TestItem[]) {
    item.children.forEach((child) => {
      items.push(child);
      this.collectChildren(child, items);
    });
  }
}
