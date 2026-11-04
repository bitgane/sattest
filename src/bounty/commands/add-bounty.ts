import * as vscode from 'vscode';
import { BountyInfo } from '../bounty.types.js';
import { getRepoSlug, normalizedTestId } from '../../test/test-item.util.js';
import { CustomTestItem } from '../../test/test-item-wrapper.js';
import { announceBounty, createBounty } from '../bounty-store.js';
import { connectNostr } from '../../api/nostr.api.js';
import { getNostrUserPubkey } from '../../state.js';
import { getNwcStatus } from '../../api/nwc.api.js';
import { SignerCancelledError } from '../../api/signer-errors.js';
import { announcementsEnabled, MAX_BOUNTY_SATS, MIN_BOUNTY_SATS } from '../../api/nostr-protocol.js';
import { describeRepoIdentityFailure, getRepoIdentity } from '../../git/repo-identity.js';

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

    // Bounties are scoped to (and encrypted for) this repository, identified
    // by its first commit. Check before asking anything else.
    const identity = await getRepoIdentity();
    if (!identity.ok) {
      vscode.window.showErrorMessage(describeRepoIdentityFailure(identity.reason, identity.detail));
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
        if (sats < MIN_BOUNTY_SATS || sats > MAX_BOUNTY_SATS) {
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

      // The creator's own wallet pays the claimant when they approve, so make
      // that wallet explicit now:
      //   • connected → ask whether to use it (showing which wallet) or swap.
      //   • not connected → launch the connect flow so the user lands in one
      //     continuous flow.
      let nwcStatus = await getNwcStatus();
      if (nwcStatus.configured) {
        if (!rememberWalletForSession) {
          const label = nwcStatus.lud16 || nwcStatus.relay || 'your connected wallet';
          // The address shown is whatever `lud16` the wallet embedded in its
          // NWC connection string — it identifies the funding wallet and is
          // display-only (payouts go to the claimer's address, never here).
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
              title: 'Which Lightning wallet should pay this bounty?',
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
              vscode.window.showWarningMessage('No Lightning wallet connected — bounty not created.');
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

      // Opt-in public announcement. Bounty details are encrypted to the
      // repository by default; announcing makes the test name, amount and repo
      // public, so it is only ever done with explicit consent.
      let announce = false;
      if (announcementsEnabled()) {
        const visibility = await vscode.window.showQuickPick(
          [
            {
              label: 'Keep it private to this repository',
              detail: 'Only people with a copy of the repository can read the bounty (default)',
              announce: false,
            },
            {
              label: '$(megaphone) Announce publicly',
              detail:
                'Posts the test name, amount and repository publicly on Nostr, tagging the Sattest account so it can share it',
              announce: true,
            },
          ],
          { title: 'Who can see this bounty?', ignoreFocusOut: true }
        );
        if (!visibility) {
          return;
        }
        announce = visibility.announce;
      }

      const repoSlug = await getRepoSlug();
      const created = await createBounty({
        amountSats,
        testId,
        testLabel: test.label,
        repoSlug,
        memo: `Bounty for test "${test.label}"`,
      });

      const fullBounty: BountyInfo = {
        ...created,
        testItem: {
          id: created.testId,
          label: test.label,
          uri: test.uri,
          range: test.range,
          realTestItem: test,
          children: [],
        } as CustomTestItem,
      };

      bounties.set(test.id, fullBounty);
      onBountiesChangedEmitter.fire();
      vscode.commands.executeCommand('setContext', 'testItemHasBounty', true);

      if (announce) {
        await announceBounty(fullBounty, 'bounty');
      }

      vscode.window.showInformationMessage(
        `✅ Bounty created: ${amountSats} sats for "${test.label}". ` +
          `Sats will move from your connected wallet when you approve a claim.`
      );
    } catch (error) {
      if (error instanceof SignerCancelledError) {
        return;
      }
      console.error('Error adding bounty:', error);
      vscode.window.showErrorMessage(
        `Failed to create bounty: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  });
};
