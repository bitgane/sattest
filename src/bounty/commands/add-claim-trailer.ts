import * as vscode from 'vscode';
import { BountyInfo } from '../bounty.types.js';
import { getNostrUserPubkey } from '../../state.js';
import { hasCommits, headHasClaimTrailer } from '../../git/claim-trailer.js';
import { runAddClaimTrailer } from './claim-trailer-prompt.js';

/**
 * `sattest.addClaimTrailer` — standalone entry point for the same operation,
 * so a claimant who dismissed the prompt (or committed after claiming) can
 * still tag their work without re-filing the claim.
 *
 * The trailer is derived per bounty, so this has to ask which one. The
 * claimant knows; the extension can't infer it, because the public listing
 * deliberately doesn't say who filed which claim.
 */
export const addClaimTrailerCommand = (bounties: Map<string, BountyInfo>) =>
  vscode.commands.registerCommand('sattest.addClaimTrailer', async (test?: vscode.TestItem) => {
    const pubkey = await getNostrUserPubkey();
    if (!pubkey) {
      vscode.window.showErrorMessage(
        'Connect Nostr first (Ctrl+Alt+N) — the trailer records which identity is claiming.'
      );
      return;
    }
    if (!hasCommits()) {
      vscode.window.showErrorMessage('No commit to tag yet — commit your fix first.');
      return;
    }

    // Invoked from a test's context menu, we already know the bounty.
    let bounty = test?.id ? bounties.get(test.id.trim()) : undefined;
    if (!bounty) {
      const candidates = Array.from(bounties.values()).filter((b) => b.active);
      if (candidates.length === 0) {
        vscode.window.showErrorMessage('No active bounties in this workspace to tag a claim for.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        candidates.map((b) => ({
          label: b.testItem?.label ?? b.testId,
          description: `${b.amountSats} sats`,
          bounty: b,
        })),
        { title: 'Which bounty are you claiming?', ignoreFocusOut: true }
      );
      if (!picked) {
        return;
      }
      bounty = picked.bounty;
    }

    if (headHasClaimTrailer(bounty.id, pubkey)) {
      vscode.window.showInformationMessage('Your latest commit is already tagged with this claim.');
      return;
    }
    await runAddClaimTrailer(bounty.id, pubkey);
  });
