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
import { findTestItemById } from './test/test-item.util.js';
import { activateTestController, myTestController } from './test/test-controller.js';
import { CustomTestItem } from './test/test-item-wrapper.js';
import { connectNostr } from './api/nostr.api.js';
import { getNostrUserPubkey, initializeSecrets } from './state.js';
import { SUPPORTED_LANGUAGE_IDS } from './test/language-configs.js';

export async function activate(context: vscode.ExtensionContext) {
  initializeSecrets(context);

  const bounties = new Map<string, BountyInfo>();
  const onBountiesChangedEmitter = new vscode.EventEmitter<void>();
  const userNostrPubkey = await getNostrUserPubkey();

  // Activate Test Controller & register tests
  activateTestController(context);

  // Load bounties from backend on startup
  let backendBounties: BountyInfo[] = [];
  try {
    backendBounties = await fetchBounties();
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
        fetchBounties()
          .then((backendBounties) => {
            attachTestItems(backendBounties, bounties);
            onBountiesChangedEmitter.fire();
          })
          .catch((err) => console.error('[Extension] Refresh failed:', err));
      }
    })
  );

  // NEW: Wait for Test Controller to populate items, then re-attach testItems
  const checkTestItemsInterval = setInterval(() => {
    const count = myTestController.items.size;
    if (count > 0) {
      attachTestItems(backendBounties, bounties);
      onBountiesChangedEmitter.fire();
      clearInterval(checkTestItemsInterval); // stop polling
    }
  }, 2000); // check every 2 seconds

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
