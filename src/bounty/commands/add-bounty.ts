import * as vscode from 'vscode';
import { BountyInfo } from '../bounty.types.js';
import { getRepoSlug, normalizedTestId } from '../../test/test-item.util.js';
import { CustomTestItem } from '../../test/test-item-wrapper.js';
import { showBountyInvoicePanel } from '../invoice-webview.js';
import { createBounty } from '../../api/bounty.api.js';
import { connectNostr } from '../../api/nostr.api.js';
import {
  getIsDefaultLnbits,
  getNostrUserPubkey,
  setIsDefaultLnbits,
} from '../../state.js';
import { configureLnbits, getLnbitsConfig } from '../../api/lnbits.api.js';
import { getNwcStatus } from '../../api/nwc.api.js';

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
