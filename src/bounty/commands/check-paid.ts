import * as vscode from 'vscode';
import { BountyInfo } from '../bounty.types.js';
import { showBountyInvoicePanel } from '../invoice-webview.js';
import { checkPaidStatus, updatePaidStatus } from '../../api/bounty.api.js';

export const checkPaidCommand = (
  bounties: Map<string, BountyInfo>,
  onBountiesChangedEmitter: vscode.EventEmitter<void>,
  context: vscode.ExtensionContext
) =>
  vscode.commands.registerCommand('sattest.checkPaid', async (test?: vscode.TestItem) => {
    if (!test || !test.id) {
      vscode.window.showErrorMessage('No test selected');
      return;
    }

    const bounty = bounties.get(test.id);
    if (!bounty || !bounty.paymentHash) {
      vscode.window.showInformationMessage('No bounty or payment hash for this test');
      return;
    }

    try {
      const lnbitsPaid = await checkPaidStatus(bounty.paymentHash);

      if (lnbitsPaid !== bounty.invoicePaid) {
        const syncSuccess = await updatePaidStatus(bounty.id);
        if (syncSuccess) {
          bounty.invoicePaid = lnbitsPaid;
          bounties.set(test.id, bounty);
          onBountiesChangedEmitter.fire();
          await context.globalState.update('bountyTests', Object.fromEntries(bounties));
        }
      }

      // 4. Show final message based on synced state
      if (bounty.invoicePaid) {
        vscode.window.showInformationMessage(`Bounty funded! ${bounty.amountSats} sats in bounty.`);
      } else {
        // QR/webview to fund the bounty
        await showBountyInvoicePanel(test, bounty, bounties, context, onBountiesChangedEmitter);
        vscode.window.showInformationMessage(
          `Bounty not yet funded for ${test.label}. QR panel opened. Fund it!`
        );
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Error checking payment: ${err}`);
    }
  });
