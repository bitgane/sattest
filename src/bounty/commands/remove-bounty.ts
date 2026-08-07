import * as vscode from 'vscode';
import {
  BountyInfo,
  claimStatusApproved,
  claimStatusPending,
} from '../bounty.types.js';
import { getNostrUserPubkey } from '../../state.js';
import { promptForLnurl } from '../lnurl-input.js';
import { deactivateBounty } from '../../api/bounty.api.js';

export const removeBountyCommand = (
  bounties: Map<string, BountyInfo>,
  onBountiesChangedEmitter: vscode.EventEmitter<void>,
  context: vscode.ExtensionContext
) =>
  vscode.commands.registerCommand('sattest.removeBounty', async (test?: vscode.TestItem) => {
    if (!test) {
      vscode.window.showErrorMessage('No test selected');
      return;
    }

    const bounty = bounties.get(test.id);

    // Only the bounty creator can remove it
    if (bounty?.creatorId) {
      const userNostrPubkey = await getNostrUserPubkey();
      if (bounty.creatorId !== userNostrPubkey) {
        vscode.window.showErrorMessage('Not authorized to remove this bounty');
        return;
      }
    }
    if (!bounty) {
      vscode.window.showInformationMessage(`No bounty on test "${test.label}"`);
      return;
    }

    // A bounty whose claim is already approved has been paid out — flag that in
    // the confirm so the creator knows removing it doesn't reclaim funds; it
    // just frees the test for a fresh bounty as the code evolves.
    const alreadyPaid = bounty.claims?.[0]?.status === claimStatusApproved;
    const confirm = await vscode.window.showWarningMessage(
      alreadyPaid
        ? `Remove this paid ${bounty.amountSats} sats bounty from "${test.label}"?`
        : `Remove ${bounty.amountSats} sats bounty from "${test.label}"?`,
      {
        modal: true,
        detail: alreadyPaid
          ? 'This bounty was already paid out. Removing it frees the test so you can add new bounties to it as the code evolves.'
          : undefined,
      },
      'Yes, Remove'
    );

    if (confirm !== 'Yes, Remove') {
      return;
    }

    // Determine refund eligibility. Funds are only recoverable if the
    // invoice was actually paid and the claim hasn't already been approved
    // (approved = sats already went to the claimant, nothing left to refund).
    // NWC bounties are never refundable here — no sats were ever custodied;
    // the creator's own wallet holds them and simply won't be drawn down.
    const latestClaimStatus = bounty.claims?.[0]?.status;
    const canRefund =
      bounty.fundingMode !== 'nwc' &&
      bounty.invoicePaid &&
      latestClaimStatus !== claimStatusApproved;
    const hasPendingClaim = latestClaimStatus === claimStatusPending;

    let refundLnurl: string | undefined;

    if (canRefund) {
      // A pending claim means somebody is actively trying to collect. Warn
      // the creator that refunding orphans that claim.
      if (hasPendingClaim) {
        const proceed = await vscode.window.showWarningMessage(
          `A claim is pending on this bounty. Refunding will abandon the claimant. Continue?`,
          { modal: true },
          'Refund Anyway'
        );
        if (proceed !== 'Refund Anyway') {
          return;
        }
      }

      refundLnurl = await promptForLnurl(
        `Refund ${bounty.amountSats} sats`,
        'Paste the LNURL or LN address to receive the refund',
        { amountSats: bounty.amountSats }
      );
      if (!refundLnurl) {
        return; // user cancelled the LNURL prompt
      }
    }

    try {
      // Call the backend helper to set active = false (and optionally refund)
      const result =  await deactivateBounty(bounty.id, refundLnurl);

      if (!result.success) {
        // Error already shown by the helper; leave local state untouched so
        // the user can retry.
        return;
      }

      // Remove from local map
      bounties.delete(test.id);

      // Fire event to refresh UI (CodeLens, Test Explorer, etc.)
      onBountiesChangedEmitter.fire();

      // Optional: update context if needed
      vscode.commands.executeCommand('setContext', 'testItemHasBounty', bounties.size > 0);

      if (result.refund && refundLnurl) {
        const shortLnurl =
          refundLnurl.length > 32
            ? `${refundLnurl.slice(0, 16)}…${refundLnurl.slice(-10)}`
            : refundLnurl;
        vscode.window.showInformationMessage(
          `Refunded ${result.refund.amountSats} sats to ${shortLnurl}.`
        );
      } else {
        vscode.window.showInformationMessage(
          `Bounty removed from "${test.label}" (${bounty.amountSats} sats)`
        );
      }
    } catch (error) {
      console.error('[removeBountyCommand] Error deactivating bounty:', error);
      vscode.window.showErrorMessage(
        `Failed to deactivate bounty: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  });
