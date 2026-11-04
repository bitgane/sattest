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
 * Tag the claimant's latest commit with their claim trailer — used when they
 * chose "Tag my latest commit" while claiming, so there is no second prompt.
 *
 * The trailer is what lets a creator tell this claim from anyone else's when
 * several people claim the same bounty: the pubkey travels inside a commit,
 * and a commit only reaches the creator's history if they merge it.
 *
 * Never throws — a claim that succeeded must not be reported as failed just
 * because the trailer step didn't work out.
 */
export async function tagLatestCommitForClaim(bountyId: string): Promise<void> {
  try {
    const pubkey = await getNostrUserPubkey();
    if (!pubkey) {
      return;
    }
    if (!hasCommits()) {
      vscode.window.showInformationMessage(
        `Add "${CLAIM_TRAILER_KEY}: ${claimTrailerToken(bountyId, pubkey)}" to the commit with ` +
          'your fix so the bounty creator can match it to your claim, or run ' +
          '"Sattest: Add Claim Trailer to Latest Commit" once you\'ve committed.'
      );
      return;
    }
    if (headHasClaimTrailer(bountyId, pubkey)) {
      return; // already tagged — nothing to do
    }
    await runAddClaimTrailer(bountyId, pubkey);
  } catch (err) {
    console.error('[tagLatestCommitForClaim] skipped:', err);
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
