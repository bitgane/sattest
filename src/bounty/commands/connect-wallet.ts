import * as vscode from 'vscode';
import { connectNostr } from '../../api/nostr.api.js';
import { confirmBackendForNwc, setNwcUri } from '../../api/nwc.api.js';
import { getNostrUserPubkey } from '../../state.js';

export const connectWalletCommand = (
  context: vscode.ExtensionContext,
  onBountiesChangedEmitter: vscode.EventEmitter<void>
) =>
  vscode.commands.registerCommand('sattest.connectWallet', async () => {
    const userNostrPubkey = await getNostrUserPubkey();
    if (!userNostrPubkey) {
      vscode.window.showErrorMessage(
        'Connect to Nostr first (Ctrl/Cmd+Alt+N), then link your wallet.'
      );
      return;
    }
    const uri = await vscode.window.showInputBox({
      title: 'Connect Lightning Wallet (NIP-47)',
      prompt: 'Paste your NWC connection string from Alby Hub, Mutiny, Coinos, etc.',
      placeHolder: 'nostr+walletconnect://...',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) =>
        v.trim().startsWith('nostr+walletconnect://')
          ? null
          : 'Expected a nostr+walletconnect:// URI',
    });
    if (!uri) {
      return;
    }

    // The NWC URI is a spending credential. Before it leaves the machine,
    // confirm the destination when it isn't the default backend or localhost
    // (guards a social-engineered backendUrl change).
    if (!(await confirmBackendForNwc(context))) {
      vscode.window.showWarningMessage(
        'Wallet not connected — backend not confirmed. Check sattest.backendUrl in your User settings.'
      );
      return;
    }

    // Budget window is informational — the real limit lives in the
    // creator's wallet. We surface it in the UI for reassurance.
    const windowChoice = await vscode.window.showQuickPick(
      [
        { label: 'Daily budget window', value: 'daily' as const },
        { label: 'Weekly budget window', value: 'weekly' as const },
        { label: 'Monthly budget window', value: 'monthly' as const },
        { label: 'Skip — set in my wallet app', value: undefined },
      ],
      { title: 'Budget window (optional, display only)', ignoreFocusOut: true }
    );
    if (windowChoice === undefined) {
      return; // user dismissed the quick pick
    }

    let budgetSats: number | undefined;
    if (windowChoice.value) {
      // A window was chosen, so an amount is required — connecting without a
      // budget is the quick-pick's explicit "Skip" option, not a blank here.
      const satsInput = await vscode.window.showInputBox({
        title: `Budget per ${windowChoice.value} window`,
        prompt: 'Sats (display only — enforced by your wallet)',
        placeHolder: 'e.g. 100000',
        validateInput: (v) =>
          /^\d+$/.test(v.trim()) && Number(v.trim()) > 0
            ? null
            : 'Enter a positive whole number',
      });
      if (satsInput === undefined) {
        return; // dismissed → cancel the whole connect, no DB change
      }
      budgetSats = Number(satsInput.trim());
    }

    let result = await setNwcUri(uri.trim(), budgetSats, windowChoice.value);
    if (result === 'auth-expired') {
      // The stored Nostr auth event aged out. Keep the pasted URI in scope
      // (never persisted — it holds the spending secret), reopen Connect to
      // Nostr so the user can refresh their session, then retry once with the
      // now-fresh auth. Refreshing Nostr completes the connection on its own —
      // the user never has to re-run this command.
      const reconnected = await connectNostr(context, onBountiesChangedEmitter, {
        noticeMessage: 'Refresh your Nostr login to complete your wallet connection.',
      });
      if (reconnected) {
        result = await setNwcUri(uri.trim(), budgetSats, windowChoice.value);
      }
    }

    if (result === 'ok') {
      vscode.window.showInformationMessage(
        '✅ Lightning wallet connected. New bounties can now be funded non-custodially.'
      );
    } else if (result === 'auth-expired') {
      // Reconnect dismissed, or (rare) the refreshed auth still failed.
      vscode.window.showWarningMessage(
        'Wallet not connected — refresh your Nostr login to finish connecting.'
      );
    }
  });
