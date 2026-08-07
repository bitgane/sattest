import * as vscode from 'vscode';
import {
  addBountyCommand,
  addClaimTrailerCommand,
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
import { connectNostr, refreshNostrHandleIfStale } from './api/nostr.api.js';
import { connectNostrCommand } from './bounty/commands/connect-nostr.js';
import { connectWalletCommand } from './bounty/commands/connect-wallet.js';
import { disconnectWalletCommand } from './bounty/commands/disconnect-wallet.js';
import { setAuthRefresher } from './api/authed-fetch.js';
import { getNostrUserPubkey, initializeSecrets } from './state.js';
import { SUPPORTED_LANGUAGE_IDS } from './test/language-configs.js';

export async function activate(context: vscode.ExtensionContext) {
  initializeSecrets(context);

  const bounties = new Map<string, BountyInfo>();
  const onBountiesChangedEmitter = new vscode.EventEmitter<void>();
  // Dispose the shared bounty-change emitter when the extension unloads.
  context.subscriptions.push(onBountiesChangedEmitter);
  const userNostrPubkey = await getNostrUserPubkey();

  // Teach the API layer how to recover an expired Nostr session: on a 401 from
  // a user-initiated write, reopen Connect-to-Nostr so the user re-pairs (which
  // mints a fresh auth event), then retry the request. Registered once here so
  // the api modules don't need to import the command/webview layer.
  setAuthRefresher(async () =>
    !!(await connectNostr(context, onBountiesChangedEmitter, {
      noticeMessage: 'Your Nostr session expired — reconnect to continue.',
    }))
  );

  // Activate Test Controller & register tests
  activateTestController(context);

  // Self-heal a handle that an older build persisted as a hex pubkey fallback,
  // so the "Connected as @handle" banner shows the real name next time it
  // renders. Fire-and-forget: it's a best-effort relay read that must never
  // delay or fail activation.
  void refreshNostrHandleIfStale().catch((err) =>
    console.debug('[Extension] Handle refresh skipped:', err)
  );

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
    approveClaimCommand(bounties, onBountiesChangedEmitter),
    addClaimTrailerCommand(bounties),
    connectWalletCommand(context, onBountiesChangedEmitter),
    disconnectWalletCommand()
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
  // Register the provider itself too, so its internal emitter + change listener
  // are disposed on unload (see BountyCodeLensProvider.dispose).
  context.subscriptions.push(disposable, codeLensProvider);

  // Registered after the code-lens provider is built: on connect, the command
  // pushes the freshly-paired pubkey into the provider so the creator-only
  // "Approve Claim" lens starts rendering on bounties they own.
  context.subscriptions.push(
    connectNostrCommand(context, onBountiesChangedEmitter, codeLensProvider)
  );

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
  const stopPollingTimeout = setTimeout(() => {
    clearInterval(checkTestItemsInterval);
  }, 30000);

  // Tear the poll timers down if the extension deactivates before they clear
  // themselves, so nothing keeps firing after unload.
  context.subscriptions.push({
    dispose: () => {
      clearInterval(checkTestItemsInterval);
      clearTimeout(stopPollingTimeout);
    },
  });
}

function attachTestItems(backendBounties: BountyInfo[], bounties: Map<string, BountyInfo>) {
  // The backend returns bounties newest-first. When a test somehow has more
  // than one active bounty, keep the first (newest) — the old forEach was
  // last-write-wins, which left the *oldest* bounty in the map and made the
  // lens/claim/approve flows act on stale data.
  const seenThisBatch = new Set<string>();
  backendBounties.forEach((b) => {
    if (seenThisBatch.has(b.testId)) {
      return;
    }
    seenThisBatch.add(b.testId);
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
