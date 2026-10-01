import * as vscode from 'vscode';
import { BountyInfo, claimStatusPending } from '../bounty.types.js';
import { promptForLnurl } from '../lnurl-input.js';
import { claimBountyWithLnAddress } from '../../api/bounty.api.js';
import { offerClaimTrailer } from './claim-trailer-prompt.js';

export const claimBountyCommand = (
  bounties: Map<string, BountyInfo>,
  onBountiesChangedEmitter: vscode.EventEmitter<void>
) =>
  vscode.commands.registerCommand('sattest.claimBounty', async (test?: vscode.TestItem) => {
    if (!test || !test.id) {
      vscode.window.showErrorMessage('No test selected');
      return;
    }
    const bounty = bounties.get(test.id);
    if (!bounty || !bounty.invoicePaid || !!bounty.claims?.[0]?.status) {
      vscode.window.showErrorMessage('Bounty not funded yet or already claimed');
      return;
    }
    const lnurl = await promptForLnurl(
      `Claim ${bounty.amountSats} sats bounty`,
      'Paste your LNURL or LN address',
      { amountSats: bounty.amountSats }
    );

    if (!lnurl) {
      return;
    }

    // Privacy choice: by default the creator sees the destination address when
    // they approve (lets them eyeball where funds go). A claimant who'd rather
    // not reveal their LN address can hide it — the backend still pays it, but
    // never discloses it to the creator's client. Dismissing (Esc) cancels the
    // claim so the address is never sent without an explicit privacy decision.
    //
    // Honest caveat for NWC bounties: those pay out from the *creator's own*
    // wallet, so the invoice the backend fetches from the claimant's LN address
    // may still expose it in that wallet's payment record — hiding it in our UI
    // can't reach into the payer's wallet. Custodial payouts go through the
    // LNbits host, so the creator truly never sees it. Spell that out so the
    // claimant's expectation matches reality for the bounty they're claiming.
    const isNwc = bounty.fundingMode === 'nwc';
    const hideDetail = isNwc
      ? "Private claim — the creator won't see your address in the extension, but their own wallet may still show it when it pays"
      : "Private claim — the payout still reaches you, but the creator won't see your address";
    const privacyChoice = await vscode.window.showQuickPick(
      [
        {
          label: 'Share my Lightning address with the bounty creator',
          detail: 'They see where the payout goes when they approve (default)',
          hide: false,
        },
        {
          label: '$(eye-closed) Hide my Lightning address from the creator',
          detail: hideDetail,
          hide: true,
        },
      ],
      { title: 'Payout address privacy', ignoreFocusOut: true }
    );
    if (!privacyChoice) {
      return; // dismissed → cancel the claim, nothing sent
    }

    try {
      // Send claim to backend
      const newClaim = await claimBountyWithLnAddress(bounty.id, lnurl, privacyChoice.hide);
      // Update local cache. The bounty is fresh-from-backend so `claims` may
      // be absent or empty — always replace with the claim we just got back.
      if (newClaim?.status === claimStatusPending) {
        bounty.claims = [newClaim];
        bounties.set(test.id, bounty);
        onBountiesChangedEmitter.fire();
        // Notify claimant
        vscode.window.showInformationMessage(
          `Claim request sent for ${bounty.amountSats} sats. Waiting for creator approval.`
        );
        // Offer the trailer immediately — this is the moment the claimant has
        // the context. Without a commit carrying their pubkey, the creator has
        // no way to tell this claim from anyone else's, and it shows up in
        // their approve list as unverified.
        await offerClaimTrailer(bounty.id);
      }
    } catch (error) {
      console.error('[claimBounty] Error claiming bounty:', error);
      vscode.window.showErrorMessage(
        `Failed to claim bounty: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  });
