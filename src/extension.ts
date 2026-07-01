import * as vscode from 'vscode';
import {
  addBountyCommand,
  approveClaimCommand,
  checkPaidCommand,
  claimBountyCommand,
  removeBountyCommand,
} from './bounty/bounty.util.js';
import { BountyInfo } from './bounty/bounty.types.js';
import { BountyCodeLensProvider } from './bounty/bounty-code-lens.js';
import { fetchBounties } from './api/bounty.api.js';
import { findTestItemById, getRepoSlug, getLocalTestIds } from './test/test-item.util.js';
import { activateTestController, myTestController } from './test/test-controller.js';
import { CustomTestItem } from './test/test-item-wrapper.js';
import { connectNostr } from './api/nostr.api.js';
import { clearNwcUri, confirmBackendForNwc, getNwcStatus, setNwcUri } from './api/nwc.api.js';
import { setAuthRefresher } from './api/authed-fetch.js';
import { getNostrUserPubkey, initializeSecrets } from './state.js';
import { SUPPORTED_LANGUAGE_IDS } from './test/language-configs.js';

export async function activate(context: vscode.ExtensionContext) {
  initializeSecrets(context);

  const bounties = new Map<string, BountyInfo>();
  const onBountiesChangedEmitter = new vscode.EventEmitter<void>();
  const userNostrPubkey = await getNostrUserPubkey();

  // Teach the API layer how to recover an expired Nostr session: on a 401 from
  // a user-initiated write, reopen Connect-to-Nostr so the user re-pairs (which
  // mints a fresh auth event), then retry the request. Registered once here so
  // the api modules don't need to import the command/webview layer.
  setAuthRefresher(async () =>
    !!(await connectNostr(context, onBountiesChangedEmitter, {
      noticeMessage: 'Your Nostr session expired — reconnect to continue.',
      noticeMessageWithIdentity: (id) => `Reconnect as ${id} to continue.`,
    }))
  );

  // Activate Test Controller & register tests
  activateTestController(context);

  // Resolve repo slug once at startup for all bounty queries
  const repoSlug = getRepoSlug();

  // Load bounties from backend on startup
  let backendBounties: BountyInfo[] = [];
  try {
    backendBounties = await fetchBounties({ repo: repoSlug });
    attachTestItems(backendBounties, bounties);
  } catch (err) {
    console.error('[Extension] Failed to load bounties from backend on startup:', err);
  }

  // Force initial refresh
  onBountiesChangedEmitter.fire();

  // Register commands
  context.subscriptions.push(
    addBountyCommand(bounties, onBountiesChangedEmitter, context),
    removeBountyCommand(bounties, onBountiesChangedEmitter, context),
    checkPaidCommand(bounties, onBountiesChangedEmitter, context),
    claimBountyCommand(bounties, onBountiesChangedEmitter),
    approveClaimCommand(bounties, onBountiesChangedEmitter)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sattest.connectNostr', async () => {
      await connectNostr(context, onBountiesChangedEmitter);
      // The code-lens provider was constructed during activation with whatever
      // pubkey was cached at that moment (often `undefined`). Now that the
      // user has connected, push the fresh pubkey in so the creator-only
      // "Approve Claim" lens starts rendering on bounties they own.
      const refreshedPubkey = await getNostrUserPubkey();
      codeLensProvider.setUserNostrPubkey(refreshedPubkey);
    })
  );

  // NWC (Nostr Wallet Connect) — lets the creator connect their own
  // Lightning wallet so new bounties can be funded non-custodially. The URI
  // is a secret: it's sent to the backend exactly once (PATCH /users/me/nwc)
  // and never displayed afterwards.
  context.subscriptions.push(
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
        const satsInput = await vscode.window.showInputBox({
          title: `Budget per ${windowChoice.value} window`,
          prompt: 'Sats (display only — enforced by your wallet)',
          placeHolder: 'e.g. 100000',
          validateInput: (v) => {
            if (!v.trim()) {
              return null; // allow skip
            }
            return /^\d+$/.test(v.trim()) && Number(v.trim()) > 0
              ? null
              : 'Enter a positive whole number or leave blank';
          },
        });
        if (satsInput && satsInput.trim()) {
          budgetSats = Number(satsInput.trim());
        }
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
          noticeMessageWithIdentity: (id) =>
            `Refresh your Nostr connection as ${id} to complete your wallet connection.`,
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
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sattest.disconnectWallet', async () => {
      const status = await getNwcStatus();
      if (!status.configured) {
        vscode.window.showInformationMessage('No Lightning wallet is currently connected.');
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        'Disconnect your Lightning wallet? Existing non-custodial bounties will fail to pay out on approval until you reconnect.',
        { modal: true },
        'Disconnect'
      );
      if (confirm !== 'Disconnect') {
        return;
      }
      const ok = await clearNwcUri();
      if (ok) {
        vscode.window.showInformationMessage('Lightning wallet disconnected.');
      }
    })
  );

  // Create and register CodeLens provider
  const codeLensProvider = new BountyCodeLensProvider(
    bounties,
    onBountiesChangedEmitter,
    userNostrPubkey
  );

  const disposable = vscode.languages.registerCodeLensProvider(
    SUPPORTED_LANGUAGE_IDS.map((lang) => ({ language: lang, scheme: 'file' })),
    codeLensProvider
  );
  context.subscriptions.push(disposable);

  // Force refresh for already-open editors on activation
  vscode.window.visibleTextEditors.forEach((editor) => {
    if (SUPPORTED_LANGUAGE_IDS.includes(editor.document.languageId)) {
      codeLensProvider._onDidChangeCodeLenses.fire();
    }
  });

  // Refresh bounties & lenses when switching active editor
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && SUPPORTED_LANGUAGE_IDS.includes(editor.document.languageId)) {
        console.debug('[Extension] Active editor changed – refreshing bounties & lenses');
        const localIds = getLocalTestIds();
        fetchBounties({ repo: repoSlug, testIds: localIds.length > 0 ? localIds : undefined })
          .then((backendBounties) => {
            attachTestItems(backendBounties, bounties);
            onBountiesChangedEmitter.fire();
          })
          .catch((err) => console.error('[Extension] Refresh failed:', err));
      }
    })
  );

  // Wait for Test Controller to populate items, then re-fetch with precise filters
  const checkTestItemsInterval = setInterval(() => {
    const count = myTestController.items.size;
    if (count > 0) {
      clearInterval(checkTestItemsInterval);
      const localIds = getLocalTestIds();
      fetchBounties({ repo: repoSlug, testIds: localIds.length > 0 ? localIds : undefined })
        .then((filtered) => {
          backendBounties = filtered;
          attachTestItems(backendBounties, bounties);
          onBountiesChangedEmitter.fire();
        })
        .catch((err) => console.error('[Extension] Filtered re-fetch failed:', err));
    }
  }, 2000);

  // Stop polling after 30 seconds max
  setTimeout(() => {
    clearInterval(checkTestItemsInterval);
  }, 30000);
}

function attachTestItems(backendBounties: BountyInfo[], bounties: Map<string, BountyInfo>) {
  backendBounties.forEach((b) => {
    const testItem = findTestItemById(b.testId) as CustomTestItem;
    if (testItem) {
      b.testItem = testItem;
    } else {
      console.warn('No TestItem found:');
    }
    bounties.set(b.testId, b);
  });
}

export function deactivate() {}
