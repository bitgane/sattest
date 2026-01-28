import * as vscode from 'vscode';
import {
  addBountyCommand,
  checkPaidCommand,
  claimBountyCommand,
  removeBountyCommand,
} from './bounty/bounty.util';
import { BountyInfo } from './bounty/bounty.types';
import { BountyCodeLensProvider } from './bounty/bounty-code-lens';

const bounties = new Map<string, BountyInfo>();
const onBountiesChanged = new vscode.EventEmitter<void>(); // test.id → bounty

export function activate(context: vscode.ExtensionContext) {
  console.log('Bounty plugin activated!'); // Should appear in Dev Tools Console

  // Load persisted bounties on startup
  const persisted = context.globalState.get<{ [key: string]: BountyInfo }>('bountyTests') || {};
  Object.entries(persisted).forEach(([testId, info]) => {
    bounties.set(testId, info);
    bounties.set(testId, info);
    onBountiesChanged.fire();
  });

  const addBountyCmd = addBountyCommand(bounties, onBountiesChanged, context);
  const removeBountyCmd = removeBountyCommand(bounties, onBountiesChanged, context);
  const checkPaidCmd = checkPaidCommand(bounties, onBountiesChanged, context);
  const claimBountyCmd = claimBountyCommand(bounties, onBountiesChanged, context);

  // Register CodeLens provider and pass bounties Map
  const codeLensProvider = new BountyCodeLensProvider(bounties);
  const codeLensDisposable = vscode.languages.registerCodeLensProvider(
    [
      { language: 'typescript', scheme: 'file' },
      { language: 'javascript', scheme: 'file' },
      // add more languages as needed: python, java, etc.
    ],
    codeLensProvider
  );
  // refresh CodeLens when bounties change
  context.subscriptions.push(
    onBountiesChanged.event(() => {
      vscode.commands.executeCommand('editor.action.forceCodeLensRefresh');
    })
  );

  context.subscriptions.push(checkPaidCmd);
  context.subscriptions.push(removeBountyCmd);
  context.subscriptions.push(addBountyCmd);
  context.subscriptions.push(claimBountyCmd);
  context.subscriptions.push(codeLensDisposable);
}

export function deactivate() {}
