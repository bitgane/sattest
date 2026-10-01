import * as vscode from 'vscode';
import { clearNwcUri, getNwcStatus } from '../../api/nwc.api.js';

export const disconnectWalletCommand = () =>
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
  });
