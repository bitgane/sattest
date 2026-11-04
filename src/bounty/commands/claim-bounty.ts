import * as vscode from 'vscode';
import { BountyInfo, claimStatusPending } from '../bounty.types.js';
import { promptForLnurl } from '../lnurl-input.js';
import { claimBounty } from '../bounty-store.js';
import { tagLatestCommitForClaim } from './claim-trailer-prompt.js';
import { getNostrUserPubkey } from '../../state.js';
import { SignerCancelledError } from '../../api/signer-errors.js';
import { announcementsEnabled } from '../../api/nostr-protocol.js';

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
    if (!bounty || bounty.status !== 'open') {
      vscode.window.showErrorMessage('This bounty is not open for claims');
      return;
    }

    const claimantPubkey = await getNostrUserPubkey();
    if (!claimantPubkey) {
      vscode.window.showErrorMessage(
        'Connect Nostr first (Ctrl+Alt+N) — your claim is signed with your Nostr identity.'
      );
      return;
    }
    const existing = bounty.claims.find((c) => c.claimantPubkey === claimantPubkey);
    if (existing) {
      const again = await vscode.window.showInformationMessage(
        'You have already claimed this bounty. Claim again to replace your payout address?',
        'Replace payout address'
      );
      if (again !== 'Replace payout address') {
        return;
      }
    }

    const lnurl = await promptForLnurl(
      `Claim ${bounty.amountSats} sats bounty`,
      'Paste your LNURL or Lightning address — it\'s encrypted so only the bounty creator can read it',
      { amountSats: bounty.amountSats }
    );
    if (!lnurl) {
      return;
    }

    // How the creator tells this claim apart from anyone else's. A signed claim
    // proves who is claiming, not who did the work; a tagged commit ties the
    // claim to code the creator merges. That matters when several people claim,
    // so tagging is the default — but it's optional, because on a small team
    // the creator usually already knows who is working on what.
    const verification = await vscode.window.showQuickPick(
      [
        {
          label: '$(git-commit) Tag my latest commit (recommended)',
          detail:
            'Best for public or busy repositories, or when others might claim this bounty too. ' +
            'Adds a Sattest-Claim line to your latest commit, so the creator can match your claim ' +
            'to the code they merge. Push the commit afterwards.',
          tag: true,
        },
        {
          label: 'Skip tagging',
          detail:
            "Fine when the creator already knows you're the one working on this, such as on a " +
            'small team or a bounty you arranged together. Your claim is still signed with your Nostr key.',
          tag: false,
        },
      ],
      { title: 'How will the bounty creator know this work is yours?', ignoreFocusOut: true }
    );
    if (!verification) {
      return; // dismissed → cancel the claim, nothing sent
    }

    // The payout address is encrypted so only the bounty creator can read it:
    // their wallet needs it to pay you, but nobody else on Nostr sees it (the
    // address prompt says so). A public payout announcement is strictly
    // opt-in, and only offered once announcements are configured — otherwise
    // there is nothing to choose, so no picker is shown.
    let publicConsent = false;
    if (announcementsEnabled()) {
      const choice = await vscode.window.showQuickPick(
        [
          {
            label: 'Claim privately',
            detail:
              'Your payout address is encrypted to the bounty creator. The claim itself (your Nostr key) is visible to anyone with the repository.',
            publicConsent: false,
          },
          {
            label: '$(megaphone) Claim, and allow a public payout announcement',
            detail:
              'If the creator also agrees, the payout may be announced publicly on Nostr with your Nostr key',
            publicConsent: true,
          },
        ],
        { title: 'Submit claim', ignoreFocusOut: true }
      );
      if (!choice) {
        return; // dismissed → cancel the claim, nothing sent
      }
      publicConsent = choice.publicConsent;
    }

    try {
      const newClaim = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Sattest: submitting your claim…' },
        () => claimBounty(bounty, lnurl, { claimantPubkey, publicConsent })
      );
      if (newClaim.status === claimStatusPending) {
        bounty.claims = [
          newClaim,
          ...bounty.claims.filter((c) => c.claimantPubkey !== claimantPubkey),
        ];
        bounties.set(test.id, bounty);
        onBountiesChangedEmitter.fire();
        vscode.window.showInformationMessage(
          verification.tag
            ? `Claim request sent for ${bounty.amountSats} sats. Waiting for creator approval.`
            : `Claim request sent for ${bounty.amountSats} sats. Waiting for creator approval. ` +
                'You can still tag a commit later with "Sattest: Add Claim Trailer to Latest Commit".'
        );
        if (verification.tag) {
          await tagLatestCommitForClaim(bounty.id);
        }
      }
    } catch (error) {
      if (error instanceof SignerCancelledError) {
        return;
      }
      console.error('[claimBounty] Error claiming bounty:', error);
      vscode.window.showErrorMessage(
        `Failed to claim bounty: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  });
