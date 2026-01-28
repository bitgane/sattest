import * as vscode from 'vscode';
import { BountyInfo } from './bounty.types';

export class BountyCodeLensProvider implements vscode.CodeLensProvider {
  private bounties: Map<string, BountyInfo>;

  constructor(bounties: Map<string, BountyInfo>) {
    this.bounties = bounties;
  }

  provideCodeLenses(
    document: vscode.TextDocument
  ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
    const lenses: vscode.CodeLens[] = [];

    let foundAny = false;
    for (const [testId, bounty] of this.bounties.entries()) {
      // Use testItem if stored, otherwise skip
      const item = bounty.testItem;
      if (!item) {
        continue;
      }

      // Only include if in current document
      if (item.uri?.toString() !== document.uri.toString()) {
        continue;
      }
      // Skip if no range
      if (!item.range) {
        continue;
      }

      foundAny = true;

      let title = '';
      let command = '';
      let tooltip = '';

      if (bounty.claimStatus === 'pending') {
        title = `💰 Claim Pending (${bounty.amountSats} sats)`;
        command = ''; // or a "View Claim Status" command
        tooltip = 'Waiting for creator approval';
      } else if (bounty.claimStatus === 'approved') {
        title = `💰 Claim Approved – Payout Sent (${bounty.amountSats} sats)`;
      } else if (bounty.claimStatus === 'rejected') {
        title = `💰 Claim Rejected (${bounty.amountSats} sats)`;
      } else if (bounty.paid) {
        title = `💰 Funded – Claimable (${bounty.amountSats} sats)`;
        command = 'bountyTestPlugin.claimBounty';
        tooltip = 'Click to claim bounty payout';
      } else if (bounty.paymentHash) {
        title = `💰 Awaiting Payment (${bounty.amountSats} sats)`;
        command = 'bountyTestPlugin.checkPaid';
        tooltip = 'Check if bounty has been funded';
      } else {
        continue;
      }

      const lens = new vscode.CodeLens(item.range, {
        title,
        command,
        arguments: [item],
        tooltip,
      });

      lenses.push(lens);
    }

    if (!foundAny) {
      console.log('[BountyCodeLens] No lenses generated for this document');
    }
    return lenses;
  }

  private collectChildren(item: vscode.TestItem, items: vscode.TestItem[]) {
    item.children.forEach((child) => {
      items.push(child);
      this.collectChildren(child, items);
    });
  }

  // Optional: if you want to resolve dynamically (rarely needed)
  resolveCodeLens?(
    codeLens: vscode.CodeLens,
    token: vscode.CancellationToken
  ): vscode.CodeLens | Thenable<vscode.CodeLens> | undefined {
    return codeLens;
  }
}
