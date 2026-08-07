import * as vscode from 'vscode';
import { connectNostr } from '../../api/nostr.api.js';
import { getNostrUserPubkey } from '../../state.js';
import { BountyCodeLensProvider } from '../bounty-code-lens.js';

export const connectNostrCommand = (
  context: vscode.ExtensionContext,
  onBountiesChangedEmitter: vscode.EventEmitter<void>,
  codeLensProvider: BountyCodeLensProvider
) =>
  vscode.commands.registerCommand('sattest.connectNostr', async () => {
    await connectNostr(context, onBountiesChangedEmitter);
    // The code-lens provider was constructed during activation with whatever
    // pubkey was cached at that moment (often `undefined`). Now that the
    // user has connected, push the fresh pubkey in so the creator-only
    // "Approve Claim" lens starts rendering on bounties they own.
    const refreshedPubkey = await getNostrUserPubkey();
    codeLensProvider.setUserNostrPubkey(refreshedPubkey);
  });
