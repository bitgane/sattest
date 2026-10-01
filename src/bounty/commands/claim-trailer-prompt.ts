import * as vscode from 'vscode';
import { getNostrUserPubkey } from '../../state.js';
import {
  CLAIM_TRAILER_KEY,
  addClaimTrailerToHead,
  claimTrailerToken,
  hasCommits,
  headHasClaimTrailer,
} from '../../git/claim-trailer.js';

/**
 * Offer to stamp the claimant's Nostr pubkey into their latest commit.
 *
 * This is what turns a claim from an assertion into something the creator can
 * verify: the pubkey travels inside a commit, and a commit only reaches the
 * creator's history if they merge it. Amending rewrites HEAD, so it is always
 * opt-in and the prompt says so.
 *
 * Never throws — a claim that succeeded must not be reported as failed just
 * because the trailer step didn't work out.
 */
export async function offerClaimTrailer(bountyId: string): Promise<void> {
  try {
    const pubkey = await getNostrUserPubkey();
    if (!pubkey) {
      return;
    }
    if (!hasCommits()) {
      vscode.window.showInformationMessage(
        `Add "${CLAIM_TRAILER_KEY}: ${claimTrailerToken(bountyId, pubkey)}" to the commit with ` +
          'your fix — it\'s how the bounty creator verifies the claim is yours. Or run ' +
          '"Sattest: Add Claim Trailer to Latest Commit" once you\'ve committed.'
      );
      return;
    }
    if (headHasClaimTrailer(bountyId, pubkey)) {
      return; // already stamped — nothing to do
    }

    const choice = await vscode.window.showInformationMessage(
      'Tag your latest commit as this claim? This adds your Nostr pubkey to the commit ' +
        'message so the bounty creator can verify the work is yours.',
      { modal: false },
      'Tag latest commit',
      'Not now'
    );
    if (choice !== 'Tag latest commit') {
      return;
    }
    await runAddClaimTrailer(bountyId, pubkey);
  } catch (err) {
    console.error('[offerClaimTrailer] skipped:', err);
  }
}

/** Amend HEAD with the claim trailer and report the outcome. Never throws. */
export async function runAddClaimTrailer(bountyId: string, pubkey: string): Promise<void> {
  try {
    const sha = addClaimTrailerToHead(bountyId, pubkey);
    vscode.window.showInformationMessage(
      `Commit ${sha.slice(0, 8)} tagged with your claim. Push it (force-push if you'd ` +
        'already pushed this commit) so the creator can verify it.'
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Couldn't tag the commit: ${err instanceof Error ? err.message : 'Unknown error'}. ` +
        `You can add "${CLAIM_TRAILER_KEY}: ${claimTrailerToken(bountyId, pubkey)}" to the ` +
        'commit message by hand.'
    );
  }
}
