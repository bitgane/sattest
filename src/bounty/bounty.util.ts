import * as vscode from 'vscode';
import {
  BountyInfo,
  claimStatusApproved,
  claimStatusApproving,
  claimStatusPending,
} from './bounty.types.js';
import {
  getRepoSlug,
  normalizedTestId,
  removeParentLabelFromTestId,
} from '../test/test-item.util.js';
import { CustomTestItem } from '../test/test-item-wrapper.js';
import { showBountyInvoicePanel } from './invoice-webview.js';
import {
  evidenceIcon,
  evidenceLabel,
  describeTopCommit,
  showClaimDiff,
  evidenceDetailLine,
} from './claim-evidence.js';
import {
  approveClaim,
  checkPaidStatus,
  claimBountyWithLnAddress,
  createBounty,
  deactivateBounty,
  getPendingClaims,
  updatePaidStatus,
} from '../api/bounty.api.js';
import type { PendingClaim } from '../api/bounty.api.js';
import { connectNostr } from '../api/nostr.api.js';
import {
  getIsDefaultLnbits,
  getNostrUserPubkey,
  setIsDefaultLnbits,
} from '../state.js';
import { configureLnbits, getLnbitsConfig } from '../api/lnbits.api.js';
import { promptForLnurl } from './lnurl-input.js';
import { getNwcStatus } from '../api/nwc.api.js';
import {
  CLAIM_TRAILER_KEY,
  addClaimTrailerToHead,
  claimTrailerToken,
  fetchAllRemotes,
  hasCommits,
  hasRemotes,
  headHasClaimTrailer,
  verifyClaimTrailer,
  type ClaimEvidence,
  type ClaimEvidenceResult,
} from '../git/claim-trailer.js';

// Custodial (LNbits invoice/QR) bounties are disabled — NWC (non-custodial) is
// the only funding path
const CUSTODIAL_BOUNTIES_ENABLED: boolean = false;

export const addBountyCommand = (
  bounties: Map<string, BountyInfo>,
  onBountiesChangedEmitter: vscode.EventEmitter<void>,
  context: vscode.ExtensionContext
) => {
  // Session-scoped: once the creator opts to stop being asked which wallet to
  // use, every subsequent bounty this session draws from the connected wallet
  // silently. Lives in the factory closure (registered once at activation), so
  // it persists for the extension-host lifetime and resets on reload.
  let rememberWalletForSession = false;

  return vscode.commands.registerCommand('sattest.addBounty', async (test: vscode.TestItem) => {
    if (!test) {
      vscode.window.showErrorMessage('No test selected');
      return;
    }
    // Check if already has bounty
    if (bounties.has(test.id)) {
      const existing = bounties.get(test.id)!;
      vscode.window.showWarningMessage(
        `Test "${test.label}" already has ${existing.amountSats} sats bounty (created ${existing.createdAt})`
      );
      return;
    }

    // Prompt for amount (sats)
    const amountInput = await vscode.window.showInputBox({
      title: `Bounty for "${test.label}"`,
      prompt: 'Enter bounty amount in satoshis (10000 for 0.0001 BTC)',
      value: '2100',
      validateInput: (value) => {
        if (!/^\d+$/.test(value.trim())) {
          return 'Enter a whole number of satoshis';
        }
        const sats = Number(value.trim());
        if (sats < 1 || sats > 50000) {
          return 'Enter 1-50K satoshis';
        }
        return null;
      },
    });
    if (!amountInput) {
      return;
    }

    const amountSats = Number(amountInput.trim());
    try {
      const testId = normalizedTestId(test);

      let userNostrPubkey = await getNostrUserPubkey();
      if (!userNostrPubkey) {
        await connectNostr(context, onBountiesChangedEmitter);
        userNostrPubkey = await getNostrUserPubkey();
      }
      if (!userNostrPubkey) {
        vscode.window.showErrorMessage('Nostr reviewer not configured.');
        return;
      }

      // NWC (non-custodial) is the only funding path by default: sats move
      // straight from the creator's wallet to the claimer on approval, never
      // touching our LNbits custody. The custodial quick-pick only renders
      // when CUSTODIAL_BOUNTIES_ENABLED is flipped on (operator decision).
      let fundingMode: 'custodial' | 'nwc' = 'nwc';
      if (CUSTODIAL_BOUNTIES_ENABLED) {
        const nwcStatus = await getNwcStatus();
        if (nwcStatus.configured) {
          const choice = await vscode.window.showQuickPick(
            [
              {
                label: 'Fund from connected Lightning wallet (non-custodial)',
                description: 'Sats move from your wallet on approval — no invoice to pay now',
                value: 'nwc' as const,
              },
              {
                label: 'Fund via Lightning invoice (custodial)',
                description: 'Pay an invoice up-front; sats held until approval',
                value: 'custodial' as const,
              },
            ],
            { title: 'How should this bounty be funded?', ignoreFocusOut: true }
          );
          if (!choice) {
            return;
          }
          fundingMode = choice.value;
        } else {
          // Custodial allowed but no wallet connected — fall back to custodial.
          fundingMode = 'custodial';
        }
      }

      // NWC bounties fund from the creator's connected wallet. Make that wallet
      // explicit at creation time:
      //   • connected → ask whether to use it (showing which wallet) or swap
      //     to a different one.
      //   • not connected → auto-launch the connect flow so the user lands in
      //     one continuous flow instead of hitting a backend 400.
      if (fundingMode === 'nwc') {
        let nwcStatus = await getNwcStatus();
        if (nwcStatus.configured) {
          // Skip the prompt entirely once the creator has opted to stop being
          // asked this session — just use whatever wallet is connected.
          if (!rememberWalletForSession) {
            // Prefer the lightning address, then the relay host, then a generic
            // fallback (covers a backend that couldn't summarize the URI).
            const label = nwcStatus.lud16 || nwcStatus.relay || 'your connected wallet';
            // The address shown is whatever `lud16` the wallet provider embedded
            // in the NWC connection string at connect time — it identifies the
            // funding wallet and is display-only (it can lag behind the alias
            // the wallet shows you today, and payouts go to the claimer's
            // LNURL, never to this address). Spell that out so a stale-looking
            // address reads as "wallet identity" rather than a wrong payee.
            const connectedAt = nwcStatus.updatedAt
              ? new Date(nwcStatus.updatedAt).toLocaleDateString()
              : undefined;
            const detail = nwcStatus.lud16
              ? `Address from your wallet's NWC connection string${
                  connectedAt ? ` · connected ${connectedAt}` : ''
                }`
              : connectedAt
                ? `Connected ${connectedAt}`
                : undefined;
            const pick = await vscode.window.showQuickPick(
              [
                {
                  label: `Use connected wallet — ${label}`,
                  description: nwcStatus.relay ?? '',
                  detail,
                  value: 'existing' as const,
                },
                {
                  label: "Use it for the rest of this session (don't ask again)",
                  description: nwcStatus.relay ?? '',
                  value: 'remember' as const,
                },
                { label: 'Connect a different wallet', value: 'different' as const },
              ],
              {
                title: 'Which Lightning wallet should fund this bounty?',
                ignoreFocusOut: true,
              }
            );
            if (!pick) {
              return; // dismissed → cancel creation
            }
            if (pick.value === 'remember') {
              rememberWalletForSession = true;
            } else if (pick.value === 'different') {
              await vscode.commands.executeCommand('sattest.connectWallet');
              nwcStatus = await getNwcStatus();
              if (!nwcStatus.configured) {
                vscode.window.showWarningMessage(
                  'No Lightning wallet connected — bounty not created.'
                );
                return;
              }
            }
          }
        } else {
          await vscode.commands.executeCommand('sattest.connectWallet');
          nwcStatus = await getNwcStatus();
          if (!nwcStatus.configured) {
            vscode.window.showWarningMessage(
              'A connected Lightning wallet is required to create a bounty. Run "Add Bounty" again after connecting your wallet.'
            );
            return;
          }
        }
      }

      // Custodial bounties still need an LNbits config choice. NWC bounties
      // skip this entirely — no invoice is minted.
      let userLnbitsConfig = await getLnbitsConfig();
      if (fundingMode === 'custodial') {
        const isDefaultLnbits = await getIsDefaultLnbits();

        if (!isDefaultLnbits) {
          // First time – offer choice
          const choice = await vscode.window.showInformationMessage(
            'Bounty actions use our default LNbits node by default.',
            'Use default (easiest)',
            'Use my own LNbits'
          );
          if (choice === 'Use my own LNbits') {
            await configureLnbits();
            // Re-fetch config after user sets it
            userLnbitsConfig = await getLnbitsConfig();

            if (!userLnbitsConfig?.url || !userLnbitsConfig?.apiKey) {
              vscode.window.showInformationMessage(
                `Lnbits info is required to manage bounties and claims. Add new bounty to choose the default or your own.`
              );
              return;
            }
          }
          await setIsDefaultLnbits((!userLnbitsConfig).toString());
        }
      }
      // Scope the bounty to the workspace's git repo. Listing is repo-scoped
      // and a bounty with no repo can never appear in it again — so refuse to
      // create one rather than minting a row that's only reachable by SQL.
      // (Bounties created before this rule are in exactly that position.)
      const repoSlug = getRepoSlug();
      if (!repoSlug) {
        vscode.window.showErrorMessage(
          'Sattest needs a git repository with an "origin" remote to create a bounty — ' +
            'bounties are scoped per repo so contributors working in the same repo can find them.'
        );
        return;
      }

      const newBountyFromBackend = await createBounty(
        amountSats,
        userLnbitsConfig?.url,
        userLnbitsConfig?.apiKey,
        test,
        userNostrPubkey,
        repoSlug,
        fundingMode
      );

      // If the backend call failed, `createBounty` already surfaced a toast
      // ("Failed to create bounty in backend") and returned undefined. Bail
      // before we open a QR panel with empty data.
      if (!newBountyFromBackend) {
        return;
      }

      // Create full local bounty by merging backend data + original testItem
      const fullBounty: BountyInfo = {
        ...newBountyFromBackend, // backend fields (id, invoice, paymentHash, etc.)
        testId: testId, // ensure consistency
        testItem: {
          id: testId,
          label: test.label,
          uri: test.uri,
          range: test.range,
          realTestItem: test,
          children: [],
        } as CustomTestItem,
      };

      bounties.set(test.id, fullBounty);
      // Fire event & update UI
      onBountiesChangedEmitter.fire();
      vscode.commands.executeCommand('setContext', 'testItemHasBounty', true);

      if (fundingMode === 'nwc') {
        // No invoice to fund — the creator's wallet pays directly on approval.
        vscode.window.showInformationMessage(
          `✅ Bounty created: ${amountSats} sats for "${test.label}". ` +
            `Sats will move from your connected wallet when you approve a claim.`
        );
      } else {
        // Custodial path: show QR + poll for payment as today.
        await showBountyInvoicePanel(test, fullBounty, bounties, context, onBountiesChangedEmitter);
        vscode.window.showInformationMessage(
          `✅ Bounty created: ${amountSats} sats for "${test.label}". QR panel opened. Fund it!`
        );
      }
    } catch (error) {
      console.error('Error adding bounty:', error);
      vscode.window.showErrorMessage(
        `Failed to create bounty: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  });
};

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
async function runAddClaimTrailer(bountyId: string, pubkey: string): Promise<void> {
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

export const approveClaimCommand = (
  bounties: Map<string, BountyInfo>,
  onBountiesChangedEmitter: vscode.EventEmitter<void>
) => {
  // Approvals in flight, keyed by bounty id. The signer round-trip + NWC payout
  // can take many seconds, during which the "✅ Approve Claim" lens stays
  // clickable — a second click used to fire a second /approve that landed after
  // the first, surfacing a contradictory "Claim is not pending" failure toast
  // next to the success. Guarding here stops the duplicate request at the source.
  const inFlight = new Set<string>();

  return vscode.commands.registerCommand('sattest.approveClaim', async (test?: vscode.TestItem) => {
    if (!test || !test.id) {
      vscode.window.showErrorMessage('No test selected');
      return;
    }

    let bounty = bounties.get(test.id.trim()) as BountyInfo;
    if (!bounty && test.parent) {
      const testId = removeParentLabelFromTestId(test);
      bounty = bounties.get(testId) as BountyInfo;
    }
    if (!bounty) {
      vscode.window.showErrorMessage('Bounty not found');
      return;
    }
    const userNostrPubkey = await getNostrUserPubkey();
    if (bounty.creatorId !== userNostrPubkey) {
      vscode.window.showErrorMessage('Not authorized to approve this claim');
      return;
    }

    // Ignore a second click while an approval for this bounty is already
    // running (the payout can take a while — see `inFlight` above).
    if (inFlight.has(bounty.id)) {
      vscode.window.showInformationMessage('This claim is already being approved…');
      return;
    }

    // Fetch the open claims from the backend before showing the confirmation
    // dialog. This serves three purposes:
    //   1. Transparency — the creator sees who is being paid, and (unless the
    //      claimant hid it) which LNURL receives the funds.
    //   2. Choice — claims are open to anyone, so a bounty can have several.
    //      The creator identifies their contributor out-of-band, so only they
    //      can say which claim is the right one. Picking "the newest" for them
    //      is what let an attacker file a late claim and be paid instead.
    //   3. Claim binding — we pass both `claimId` and `claimantPubkey` to the
    //      approve endpoint, so a claim substituted in the interim is rejected
    //      rather than silently paid.
    const pendingClaims = await getPendingClaims(bounty.id);
    if (pendingClaims.length === 0) {
      vscode.window.showErrorMessage(
        'Could not retrieve claim details — the claim may have already been approved or removed.'
      );
      return;
    }

    // Look up each claimant's trailer commits in local git. This is evidence
    // for the creator to read, not a verdict: teams differ, and "in your
    // branch" is the same answer whether they merged a fork's PR or simply
    // share a feature branch with the claimant.
    const evidenceFor = (claim: PendingClaim): ClaimEvidenceResult =>
      claim.claimantPubkey
        ? verifyClaimTrailer(bounty.id, claim.claimantPubkey)
        : { evidence: 'unknown', commits: [] };

    let scored = pendingClaims.map((claim) => ({ claim, result: evidenceFor(claim) }));

    // Commits already in the creator's branch sort first — a helpful default
    // highlight, not a gate. Nothing below refuses to pay on this ordering.
    const rank: Record<ClaimEvidence, number> = {
      'in-history': 0,
      elsewhere: 1,
      absent: 2,
      unknown: 3,
    };
    const byEvidence = (
      a: { result: ClaimEvidenceResult },
      b: { result: ClaimEvidenceResult }
    ) => rank[a.result.evidence] - rank[b.result.evidence];
    scored.sort(byEvidence);

    // Nothing found anywhere, but there are remotes to ask — the commits may
    // simply not have arrived on this machine yet, which is the normal state
    // when reviewing a PR you haven't fetched. Offer to go get them rather
    // than telling the creator their workflow is wrong.
    if (scored.every((s) => s.result.evidence === 'absent') && hasRemotes()) {
      const choice = await vscode.window.showInformationMessage(
        'No commit in this repo carries this claimant\'s key yet. Fetch from your remotes and re-check?',
        'Fetch and re-check',
        'Continue anyway'
      );
      if (choice === 'Fetch and re-check') {
        const fetched = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Sattest: fetching…' },
          async () => fetchAllRemotes()
        );
        if (fetched) {
          scored = pendingClaims.map((claim) => ({ claim, result: evidenceFor(claim) }));
          scored.sort(byEvidence);
        }
      } else if (choice !== 'Continue anyway') {
        return; // dismissed → approve nothing
      }
    }

    let chosen = scored[0];
    if (scored.length > 1) {
      // More than one person has claimed this bounty. Never guess — make the
      // creator name the recipient. The pubkey is the stable identifier here;
      // the LNURL may be hidden, and is attacker-chosen either way.
      const picked = await vscode.window.showQuickPick(
        scored.map((s) => ({
          label: s.claim.claimantPubkey
            ? `${evidenceIcon(s.result.evidence)} ${s.claim.claimantPubkey.slice(0, 16)}…${s.claim.claimantPubkey.slice(-8)}`
            : '$(question) Unknown claimant (legacy claim)',
          description: [
            evidenceLabel(s.result),
            s.claim.status === claimStatusApproving ? 'payout processing' : '',
          ]
            .filter(Boolean)
            .join(' · '),
          detail: [
            describeTopCommit(s.result),
            // Say so explicitly when the address is hidden — silence would read
            // as "no address", and the creator should know the difference.
            s.claim.lnurlHidden
              ? 'address hidden by the claimant'
              : `pays ${s.claim.claimantLnurl ?? 'unknown'}`,
          ]
            .filter(Boolean)
            .join(' · '),
          // `claim` is the selection; `entry` carries the evidence alongside it
          // so the confirm dialog can show the commit without re-running git.
          claim: s.claim,
          entry: s,
        })),
        {
          title: `${scored.length} people have claimed this bounty — who are you paying?`,
          placeHolder: 'Match the commit against the work you reviewed',
          ignoreFocusOut: true,
        }
      );
      if (!picked) {
        return; // dismissed → approve nothing
      }
      chosen = picked.entry;
    }
    const pendingClaim = chosen.claim;

    // Build the destination line for the confirmation dialog. When the claimant
    // opted into privacy, the backend redacts the address (`claimantLnurl` is
    // null, `lnurlHidden` true) — the creator approves without seeing it. The
    // payout is still bound to this exact claim via `claimId` and routed to the
    // pinned address server-side, so hiding it doesn't weaken front-running
    // protection; the creator just can't eyeball the destination.
    let destinationLine: string;
    if (pendingClaim.lnurlHidden || !pendingClaim.claimantLnurl) {
      destinationLine = 'the claimant';
    } else {
      // Truncate a long LNURL so the creator can verify it without the full
      // string overwhelming the dialog. The claimId binding is the real check.
      const lnurl = pendingClaim.claimantLnurl;
      destinationLine =
        lnurl.length > 50 ? `${lnurl.slice(0, 24)}…${lnurl.slice(-16)}` : lnurl;
    }

    // A claim already in `approving` is one whose payout outcome was never
    // confirmed — the sats may or may not have left. Approving it again does
    // NOT pay blind: the backend asks the wallet what happened first, and only
    // pays if the wallet confirms the earlier attempt failed. Say that, rather
    // than showing a "Send N sats" modal that misrepresents what the click does.
    const isRecheck = pendingClaim.status === claimStatusApproving;

    let confirmed: string | undefined;
    if (isRecheck) {
      confirmed = await vscode.window.showWarningMessage(
        `Re-check this ${bounty.amountSats} sat payout with your wallet?`,
        {
          modal: true,
          detail:
            'Sattest couldn\'t confirm the last attempt. It will ask your wallet ' +
            'whether the payment went through, and only send again if your wallet ' +
            'confirms it did not.',
        },
        'Re-check Payout'
      );
    } else {
      // Loop so "Review changes" opens the patch and returns to the same
      // decision, rather than dropping the creator out of the flow. Reviewing
      // the code is the whole point of the trailer binding — the dialog is
      // where that decision is made, so the diff belongs one click away from it.
      const canReview = chosen.result.commits.length > 0;
      for (;;) {
        // Modal dialogs render VS Code's own Cancel button — passing an
        // explicit 'Cancel' item here used to show two of them. Dismissal
        // resolves to undefined, which the guard below treats as "don't approve".
        const actions = canReview
          ? ['Yes, Approve Payout', 'Review changes']
          : ['Yes, Approve Payout'];
        confirmed = await vscode.window.showWarningMessage(
          `Send ${bounty.amountSats} sats to:\n${destinationLine}`,
          {
            modal: true,
            // The claimant pubkey is always shown, even when the payout address
            // is hidden. Hiding an *address* is a supported privacy choice;
            // hiding *who is being paid* from the payer left the creator with
            // nothing to check, which is what made a substituted claim
            // invisible at exactly the moment it mattered.
            //
            // The commit line goes here rather than behind a warning modal:
            // this is the moment the creator decides, and a commit subject they
            // recognise is worth more than any grade we could compute.
            detail:
              `Bounty: "${test?.label}"\n` +
              `Claimant: ${pendingClaim.claimantPubkey ?? 'unknown (legacy claim)'}\n` +
              evidenceDetailLine(chosen.result),
          },
          ...actions
        );
        if (confirmed !== 'Review changes') {
          break;
        }
        await showClaimDiff(chosen.result, pendingClaim.claimantPubkey);
      }
    }

    if (confirmed !== (isRecheck ? 'Re-check Payout' : 'Yes, Approve Payout')) {
      return;
    }

    // NWC bounties pay out from the creator's own connected Lightning wallet,
    // which the backend reads server-side at approval time. If the extension
    // can't detect a connected wallet — the URI was never saved/was cleared, or
    // the Nostr session needed to read it has lapsed — the /approve call fails
    // before doing anything useful (and, when the session is gone, never even
    // reaches the backend). Prompt the creator to (re)connect their wallet so
    // they can paste their NWC URI and complete the payout.
    if (bounty.fundingMode !== 'custodial') {
      let nwc = await getNwcStatus();
      if (!nwc.configured) {
        const choice = await vscode.window.showWarningMessage(
          'Your Lightning wallet (NWC) isn\'t connected, so this payout can\'t be sent. Connect it to complete the approval.',
          'Connect Wallet',
          'Cancel'
        );
        if (choice !== 'Connect Wallet') {
          return;
        }
        await vscode.commands.executeCommand('sattest.connectWallet');
        nwc = await getNwcStatus();
        if (!nwc.configured) {
          vscode.window.showWarningMessage(
            'Lightning wallet still not connected — claim not approved.'
          );
          return;
        }
      }
    }

    inFlight.add(bounty.id);
    try {
      const result = await approveClaim(
        bounty.id,
        pendingClaim.id,
        pendingClaim.claimantPubkey
      );
      if (result === 'claimant-changed') {
        // The backend refused because the open-claim set changed under us (a
        // new claim landed, or this one isn't the claimant we named). The user
        // has already seen the reason; re-open the picker rather than paying.
        onBountiesChangedEmitter.fire();
        return;
      }
      if (!result) {
        // approveClaim() handles its own error toast (e.g. the backend's 502
        // with the real NWC failure reason) and returns null. Bail here so we
        // don't also show a contradictory "payout triggered" success toast.
        return;
      }

      if (result === 'in-progress') {
        // Another approve (e.g. a second VS Code window) is handling this claim
        // right now. Not our success to claim, not a failure either.
        vscode.window.showInformationMessage('This claim is already being approved…');
        return;
      }

      if (result === 'outcome-unknown') {
        // The payout request reached the wallet but no confirmation came back.
        // It may well have been paid, so this is explicitly NOT reported as a
        // failure — telling the creator it failed would push them to resend and
        // pay the claimant twice. The backend holds the claim and reconciles it
        // against the wallet on the next approve.
        vscode.window.showWarningMessage(
          'Couldn\'t confirm this payout — your wallet may have already sent it. ' +
            'The claim is on hold so it can\'t be paid twice. Don\'t resend from ' +
            'your wallet; click the "Payout Processing" lens in a minute to re-check.'
        );
        // Reflect the on-hold state so the lens stops offering Approve.
        if (bounty.claims?.[0]) {
          bounty.claims[0].status = claimStatusApproving;
        }
        bounties.set(test.id, bounty);
        onBountiesChangedEmitter.fire();
        return;
      }

      // Fresh success, or the backend told us it was already approved (a
      // duplicate that raced us). Either way the claim is approved and paid —
      // reflect that locally and show the success toast, never a failure.
      if (bounty.claims?.[0]) {
        bounty.claims[0].status = claimStatusApproved;
      }
      bounties.set(test.id, bounty);
      onBountiesChangedEmitter.fire();

      vscode.window.showInformationMessage(
        result === 'already-approved'
          ? 'This claim was already approved — payout completed.'
          : 'Claim approved – payout triggered!'
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Approval error: ${err}`);
    } finally {
      inFlight.delete(bounty.id);
    }
  });
};
