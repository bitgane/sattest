import * as vscode from 'vscode';
import {
  addBountyCommand,
  addClaimTrailerCommand,
  approveClaimCommand,
  claimBountyCommand,
  removeBountyCommand,
} from './bounty/bounty.util.js';
import { BountyInfo } from './bounty/bounty.types.js';
import { BountyCodeLensProvider } from './bounty/bounty-code-lens.js';
import {
  disposeBountyStore,
  initBountyStore,
  rankBounties,
} from './bounty/bounty-store.js';
import { buildTestItemIndex, findTestItemById } from './test/test-item.util.js';
import { activateTestController, myTestController } from './test/test-controller.js';
import { CustomTestItem } from './test/test-item-wrapper.js';
import { connectNostr, refreshNostrHandleIfStale } from './api/nostr.api.js';
import { connectNostrCommand } from './bounty/commands/connect-nostr.js';
import { connectWalletCommand } from './bounty/commands/connect-wallet.js';
import { disconnectWalletCommand } from './bounty/commands/disconnect-wallet.js';
import { setAuthRefresher } from './api/user-signer.js';
import {
  getBountyRelays,
  getNostrUserPubkey,
  getNwcUri,
  getTrustedCreators,
  initializeSecrets,
} from './state.js';
import { SUPPORTED_LANGUAGE_IDS } from './test/language-configs.js';

/** Coalesce a burst of relay events into one reload. */
const LIVE_RELOAD_DEBOUNCE_MS = 1_000;

export async function activate(context: vscode.ExtensionContext) {
  initializeSecrets(context);

  const bounties = new Map<string, BountyInfo>();
  const onBountiesChangedEmitter = new vscode.EventEmitter<void>();
  // Dispose the shared bounty-change emitter when the extension unloads.
  context.subscriptions.push(onBountiesChangedEmitter);
  const userNostrPubkey = await getNostrUserPubkey();

  // Bounties live on Nostr relays; there is no server. The store reads and
  // writes signed events and pays approved claims from the user's own wallet.
  const store = initBountyStore({
    relays: getBountyRelays,
    globalState: context.globalState,
    getNwcUri,
  });
  context.subscriptions.push({ dispose: disposeBountyStore });

  // Teach the signer layer how to recover a stale signer session: reopen
  // Connect-to-Nostr so the user re-pairs, then retry. Registered once here so
  // the api modules don't need to import the command/webview layer.
  setAuthRefresher(async () =>
    !!(await connectNostr(context, onBountiesChangedEmitter, {
      noticeMessage: 'Your Nostr signer session expired — reconnect to continue.',
    }))
  );

  // Activate Test Controller & register tests
  activateTestController(context);

  // Self-heal a handle that an older build persisted as a hex pubkey fallback.
  // Fire-and-forget: a best-effort relay read that must never delay activation.
  void refreshNostrHandleIfStale().catch((err) =>
    console.debug('[Extension] Handle refresh skipped:', err)
  );

  // Register commands
  context.subscriptions.push(
    addBountyCommand(bounties, onBountiesChangedEmitter, context),
    removeBountyCommand(bounties, onBountiesChangedEmitter, context),
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

  // Load bounties in the background, after every command and the CodeLens
  // provider are registered, so slow relays never leave commands "not found".
  // Background loads never raise a notification: failures are logged, and
  // anything the user starts reports its own errors.
  const loadBounties = async () => {
    try {
      const loaded = await store.fetchBounties({ notifyOnError: false, throwOnError: true });
      const ranked = rankBounties(loaded, await getNostrUserPubkey(), getTrustedCreators());
      // Replace, don't merge: a bounty that was cancelled or paid elsewhere
      // must disappear here too.
      bounties.clear();
      attachTestItems(ranked, bounties);
      onBountiesChangedEmitter.fire();
    } catch (err) {
      console.error('[Extension] Failed to load bounties from relays:', err);
    }
  };
  void loadBounties().then(() => store.housekeeping(userNostrPubkey));

  // Live updates: a relay event for this repository triggers a (debounced)
  // reload, replacing the old polling and refetch-on-editor-switch.
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let liveSub: { close: () => void } | undefined;
  void store
    .subscribe(() => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => void loadBounties(), LIVE_RELOAD_DEBOUNCE_MS);
    })
    .then((sub) => {
      liveSub = sub;
    })
    .catch((err) => console.warn('[Extension] Live updates unavailable:', err));

  // Test items arrive after activation; reload once they exist so the lenses
  // can attach to them.
  const checkTestItemsInterval = setInterval(() => {
    if (myTestController.items.size > 0) {
      clearInterval(checkTestItemsInterval);
      void loadBounties();
    }
  }, 2000);

  // Stop polling after 30 seconds max
  const stopPollingTimeout = setTimeout(() => {
    clearInterval(checkTestItemsInterval);
  }, 30000);

  // Tear timers and the subscription down on unload so nothing keeps firing.
  context.subscriptions.push({
    dispose: () => {
      clearInterval(checkTestItemsInterval);
      clearTimeout(stopPollingTimeout);
      clearTimeout(reloadTimer);
      liveSub?.close();
    },
  });

}

function attachTestItems(ranked: BountyInfo[], bounties: Map<string, BountyInfo>) {
  // `ranked` puts the most trustworthy bounty first (own, then trusted
  // creators, then newest). When a test has several bounties, keep the first,
  // so a stranger's newer bounty can't displace a maintainer's.
  const seenThisBatch = new Set<string>();
  // One walk of the test tree for the whole batch — resolving each bounty
  // separately re-walked it per bounty.
  const testItemIndex = buildTestItemIndex();
  ranked.forEach((b) => {
    if (seenThisBatch.has(b.testId)) {
      return;
    }
    seenThisBatch.add(b.testId);
    const testItem = findTestItemById(b.testId, testItemIndex) as CustomTestItem;
    if (testItem) {
      b.testItem = testItem;
    } else {
      console.warn('No TestItem found:');
    }
    bounties.set(b.testId, b);
  });
}

export function deactivate() {}
