import * as vscode from 'vscode';
import {
  BountyInfo,
  claimStatusApproved,
  claimStatusApproving,
  claimStatusPending,
} from '../bounty.types.js';
import { aggregateClaimStatus } from '../bounty-code-lens.js';
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

    // Read claim state the way the CodeLens does. `claims[0]` is only the
    // newest claim, so checking it alone could disagree with the lens — and,
    // on a custodial bounty, offer a refund for one already paid out to an
    // earlier claimant.
    const claimStatus = aggregateClaimStatus(bounty.claims);

    // A payout in flight, or held because its outcome was never confirmed, is
    // settled through the "Payout Processing" lens — and that lens stops
    // rendering once the bounty is inactive. Removing it now would strand the
    // payout (and a custodial refund could send the same sats twice), so send
    // the creator to re-check it first.
    if (claimStatus === claimStatusApproving) {
      vscode.window.showWarningMessage(
        `The ${bounty.amountSats} sats payout for "${test.label}" is still being confirmed, so ` +
          'this bounty can\'t be removed yet. Click its "Payout Processing" lens to re-check ' +
          'the payout with your wallet.'
      );
      return;
    }

    // A bounty whose claim is already approved has been paid out — flag that in
    // the confirm so the creator knows removing it doesn't reclaim funds; it
    // just frees the test for a fresh bounty as the code evolves.
    const alreadyPaid = claimStatus === claimStatusApproved;

    // A pending claim means someone did the work and is waiting on the creator.
    // Say so whatever the funding mode: this warning used to live on the
    // custodial refund path only, so removing a non-custodial bounty dropped
    // the claimant without a word. The button names the consequence.
    const hasPendingClaim = claimStatus === claimStatusPending;

    let detail: string | undefined;
    let confirmLabel = 'Yes, Remove';
    if (alreadyPaid) {
      detail =
        'This bounty was already paid out. Removing it frees the test so you can add new bounties to it as the code evolves.';
    } else if (hasPendingClaim) {
      detail =
        'Someone has claimed this bounty and is waiting for your review. Removing it cancels their claim, so review it first if you meant to pay them.';
      confirmLabel = 'Remove and Cancel Claim';
    }

    const confirm = await vscode.window.showWarningMessage(
      alreadyPaid
        ? `Remove this paid ${bounty.amountSats} sats bounty from "${test.label}"?`
        : `Remove ${bounty.amountSats} sats bounty from "${test.label}"?`,
      { modal: true, detail },
      confirmLabel
    );

    if (confirm !== confirmLabel) {
      return;
    }

    // Determine refund eligibility. Funds are only recoverable if the
    // invoice was actually paid and nothing has been paid out (approved = sats
    // already went to the claimant; a payout in flight was turned away above).
    // A pending claim needs no second warning — the confirm above named it.
    // NWC bounties are never refundable here — no sats were ever custodied;
    // the creator's own wallet holds them and simply won't be drawn down.
    const canRefund = bounty.fundingMode !== 'nwc' && bounty.invoicePaid && !alreadyPaid;

    let refundLnurl: string | undefined;

    if (canRefund) {
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
