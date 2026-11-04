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
      'Disconnect your Lightning wallet? Your bounties cannot be paid out until you reconnect a wallet. Also revoke the connection in your wallet app if you no longer use it.',
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
