import * as vscode from 'vscode';
import { toString } from 'qrcode';
import { BountyInfo, claimStatusApproved, claimStatusPending } from './bounty.types.js';
import {
  getRepoSlug,
  normalizedTestId,
  removeParentLabelFromTestId,
} from '../test/test-item.util.js';
import { CustomTestItem } from '../test/test-item-wrapper.js';
import * as crypto from 'crypto';
import {
  approveClaim,
  checkPaidStatus,
  claimBountyWithLnAddress,
  createBounty,
  deactivateBounty,
  setBountyCreator,
  updatePaidStatus,
} from '../api/bounty.api.js';
import { connectNostr } from '../api/nostr.api.js';
import {
  getIsDefaultLnbits,
  getNostrUserHandle,
  getNostrUserPubkey,
  setIsDefaultLnbits,
} from '../state.js';
import { configureLnbits, getLnbitsConfig } from '../api/lnbits.api.js';
import { promptForLnurl } from './lnurl-input.js';
import { getNwcStatus } from '../api/nwc.api.js';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

export const addBountyCommand = (
  bounties: Map<string, BountyInfo>,
  onBountiesChangedEmitter: vscode.EventEmitter<void>,
  context: vscode.ExtensionContext
) =>
  vscode.commands.registerCommand('sattest.addBounty', async (test: vscode.TestItem) => {
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

      // Decide the funding path up front. If the creator has connected a
      // Lightning wallet via NWC, offer them the non-custodial option; sats
      // move straight from their wallet to the claimer on approval, skipping
      // our LNbits custody entirely. Default is custodial (today's behavior).
      let fundingMode: 'custodial' | 'nwc' = 'custodial';
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
      // Scope the bounty to the workspace's git repo when possible so it
      // shows up in unauthenticated `GET /bounties?repo=...` / filter calls
      // for everyone else working in the same repo. Undefined when the
      // workspace has no configured git remote — backend stores null.
      const repoSlug = getRepoSlug();

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

      let userPubkey = await getNostrUserPubkey();

      if (fundingMode === 'nwc') {
        // No invoice to fund — the creator's wallet pays directly on approval.
        vscode.window.showInformationMessage(
          `✅ Bounty created: ${amountSats} sats for "${test.label}". ` +
            `Sats will move from your connected wallet when you approve a claim.`
        );
      } else {
        // Custodial path: show QR + poll for payment as today.
        await showBountyInvoicePlanel(test, fullBounty, bounties, context, onBountiesChangedEmitter);
        vscode.window.showInformationMessage(
          `✅ Bounty created: ${amountSats} sats for "${test.label}". QR panel opened. Fund it!`
        );
      }

      if (!userPubkey) {
        userPubkey = await getNostrUserPubkey();
      }

      if (userPubkey && userPubkey !== '' && userPubkey !== userNostrPubkey) {
        const updated = await setBountyCreator(fullBounty.id, userPubkey);
        if (updated) {
          bounties.set(test.id, updated);
          onBountiesChangedEmitter.fire();
        }
      }
    } catch (error) {
      console.error('Error adding bounty:', error);
      vscode.window.showErrorMessage(
        `Failed to create bounty: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  });

export const removeBountyCommand = (
  bounties: Map<string, BountyInfo>,
  onBountiesChangedEmitter: vscode.EventEmitter<void>,
  context: vscode.ExtensionContext
) =>
  vscode.commands.registerCommand('sattest.removeBounty', async (test?: vscode.TestItem) => {
    if (!test) {
      vscode.window.showErrorMessage('No test selected');
      return;
    }

    const bounty = bounties.get(test.id);

    // Only the bounty creator can remove it
    if (bounty?.creatorId) {
      const userNostrPubkey = await getNostrUserPubkey();
      if (bounty.creatorId !== userNostrPubkey) {
        vscode.window.showErrorMessage('Not authorized to remove this bounty');
        return;
      }
    }
    if (!bounty) {
      vscode.window.showInformationMessage(`No bounty on test "${test.label}"`);
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Remove ${bounty.amountSats} sats bounty from "${test.label}"?`,
      { modal: true },
      'Yes, Remove'
    );

    if (confirm !== 'Yes, Remove') {
      return;
    }

    // Determine refund eligibility. Funds are only recoverable if the
    // invoice was actually paid and the claim hasn't already been approved
    // (approved = sats already went to the claimant, nothing left to refund).
    // NWC bounties are never refundable here — no sats were ever custodied;
    // the creator's own wallet holds them and simply won't be drawn down.
    const latestClaimStatus = bounty.claims?.[0]?.status;
    const canRefund =
      bounty.fundingMode !== 'nwc' &&
      bounty.invoicePaid &&
      latestClaimStatus !== claimStatusApproved;
    const hasPendingClaim = latestClaimStatus === claimStatusPending;

    let refundLnurl: string | undefined;

    if (canRefund) {
      // A pending claim means somebody is actively trying to collect. Warn
      // the creator that refunding orphans that claim.
      if (hasPendingClaim) {
        const proceed = await vscode.window.showWarningMessage(
          `A claim is pending on this bounty. Refunding will abandon the claimant. Continue?`,
          { modal: true },
          'Refund Anyway'
        );
        if (proceed !== 'Refund Anyway') {
          return;
        }
      }

      refundLnurl = await promptForLnurl(
        `Refund ${bounty.amountSats} sats`,
        'Paste the LNURL or LN address to receive the refund'
      );
      if (!refundLnurl) {
        return; // user cancelled the LNURL prompt
      }
    }

    try {
      // Call the backend helper to set active = false (and optionally refund)
      const result =  await deactivateBounty(bounty.id, refundLnurl);

      if (!result.success) {
        // Error already shown by the helper; leave local state untouched so
        // the user can retry.
        return;
      }

      // Remove from local map
      bounties.delete(test.id);

      // Fire event to refresh UI (CodeLens, Test Explorer, etc.)
      onBountiesChangedEmitter.fire();

      // Optional: update context if needed
      vscode.commands.executeCommand('setContext', 'testItemHasBounty', bounties.size > 0);

      if (result.refund && refundLnurl) {
        const shortLnurl =
          refundLnurl.length > 32
            ? `${refundLnurl.slice(0, 16)}…${refundLnurl.slice(-10)}`
            : refundLnurl;
        vscode.window.showInformationMessage(
          `Refunded ${result.refund.amountSats} sats to ${shortLnurl}.`
        );
      } else {
        vscode.window.showInformationMessage(
          `Bounty removed from "${test.label}" (${bounty.amountSats} sats)`
        );
      }
    } catch (error) {
      console.error('[removeBountyCommand] Error deactivating bounty:', error);
      vscode.window.showErrorMessage(
        `Failed to deactivate bounty: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  });

export const checkPaidCommand = (
  bounties: Map<string, BountyInfo>,
  onBountiesChangedEmitter: vscode.EventEmitter<void>,
  context: vscode.ExtensionContext
) =>
  vscode.commands.registerCommand('sattest.checkPaid', async (test?: vscode.TestItem) => {
    if (!test || !test.id) {
      vscode.window.showErrorMessage('No test selected');
      return;
    }

    const bounty = bounties.get(test.id);
    if (!bounty || !bounty.paymentHash) {
      vscode.window.showInformationMessage('No bounty or payment hash for this test');
      return;
    }

    try {
      const lnbitsPaid = await checkPaidStatus(bounty.paymentHash);

      if (lnbitsPaid !== bounty.invoicePaid) {
        const syncSuccess = await updatePaidStatus(bounty.id);
        if (syncSuccess) {
          bounty.invoicePaid = lnbitsPaid;
          bounties.set(test.id, bounty);
          onBountiesChangedEmitter.fire();
          await context.globalState.update('bountyTests', Object.fromEntries(bounties));
        }
      }

      // 4. Show final message based on synced state
      if (bounty.invoicePaid) {
        vscode.window.showInformationMessage(`Bounty funded! ${bounty.amountSats} sats in bounty.`);
      } else {
        // QR/webview to fund the bounty
        await showBountyInvoicePlanel(test, bounty, bounties, context, onBountiesChangedEmitter);
        vscode.window.showInformationMessage(
          `Bounty not yet funded for ${test.label}. QR panel opened. Fund it!`
        );
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Error checking payment: ${err}`);
    }
  });

export const claimBountyCommand = (
  bounties: Map<string, BountyInfo>,
  onBountiesChangedEmitter: vscode.EventEmitter<void>
) =>
  vscode.commands.registerCommand('sattest.claimBounty', async (test?: vscode.TestItem) => {
    if (!test || !test.id) {
      vscode.window.showErrorMessage('No test selected');
      return;
    }
    const bounty = bounties.get(test.id);
    if (!bounty || !bounty.invoicePaid || !!bounty.claims?.[0]?.status) {
      vscode.window.showErrorMessage('Bounty not funded yet or already claimed');
      return;
    }
    const lnurl = await promptForLnurl(
      `Claim ${bounty.amountSats} sats bounty`,
      'Paste your LNURL or LN address'
    );

    if (!lnurl) {
      return;
    }

    try {
      // Send claim to backend
      const newClaim = await claimBountyWithLnAddress(bounty.id, lnurl);
      // Update local cache. The bounty is fresh-from-backend so `claims` may
      // be absent or empty — always replace with the claim we just got back.
      if (newClaim?.status === claimStatusPending) {
        bounty.claims = [newClaim];
        bounties.set(test.id, bounty);
        onBountiesChangedEmitter.fire();
        // Notify claimant
        vscode.window.showInformationMessage(
          `Claim request sent for ${bounty.amountSats} sats. Waiting for creator approval.`
        );
      }
    } catch (error) {
      console.error('[claimBounty] Error claiming bounty:', error);
      vscode.window.showErrorMessage(
        `Failed to claim bounty: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  });

export const approveClaimCommand = (
  bounties: Map<string, BountyInfo>,
  onBountiesChangedEmitter: vscode.EventEmitter<void>
) =>
  vscode.commands.registerCommand('sattest.approveClaim', async (test?: vscode.TestItem) => {
    if (!test || !test.id) {
      vscode.window.showErrorMessage('No test selected');
      return;
    }

    let bounty = bounties.get(test.id.trim()) as BountyInfo;
    if (!bounty && test.parent) {
      const testId = removeParentLabelFromTestId(test);
      bounty = bounties.get(testId) as BountyInfo;
    }
    if (!bounty) {
      vscode.window.showErrorMessage('Bounty not found');
      return;
    }
    const userNostrPubkey = await getNostrUserPubkey();
    if (bounty.creatorId !== userNostrPubkey) {
      vscode.window.showErrorMessage('Not authorized to approve this claim');
      return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      `Approve claim of ${bounty.amountSats} sats for "${test?.label}"?`,
      'Yes, Approve Payout',
      'Cancel'
    );

    if (confirmed !== 'Yes, Approve Payout') {
      return;
    }

    try {
      const updatedBounty = await approveClaim(bounty.id, userNostrPubkey);
      if (updatedBounty) {
        // Update local state. Guard against an empty/missing claims array —
        // shouldn't happen on the approve path but cheaper than a crash.
        if (bounty.claims?.[0]) {
          bounty.claims[0].status = claimStatusApproved;
        }
        bounties.set(test.id, bounty);
        onBountiesChangedEmitter.fire();
      }

      vscode.window.showInformationMessage(`Claim approved – payout triggered!`);
    } catch (err) {
      vscode.window.showErrorMessage(`Approval error: ${err}`);
    }
  });

// Helper to get wallet ID (optional, but nice for debugging)
export async function getWalletId(url: string, key: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${url}/api/v1/wallet`, {
      headers: { 'X-Api-Key': key },
    });
    if (res.ok) {
      const data = await res.json();
      return data.id;
    }
  } catch (e) {
    console.error('Failed to get wallet ID:', e);
  }
  return undefined;
}

/**
 * Generates a QR code for the invoice and sets up the Webview panel HTML.
 * @param panel - The Webview panel to update
 * @param bounty - The bounty info containing invoice and amountSats
 */
async function showBountyInvoicePlanel(
  test: vscode.TestItem,
  bounty: BountyInfo,
  bounties: Map<string, BountyInfo>,
  context: vscode.ExtensionContext,
  onBountiesChangedEmitter: vscode.EventEmitter<void>
): Promise<void> {
  // NWC bounties have no invoice or payment hash — never open the QR panel
  // for them. Callers are expected to short-circuit, but guard defensively.
  if (!bounty.invoice || !bounty.paymentHash) {
    console.warn(
      '[showBountyInvoicePlanel] Skipping panel — bounty has no invoice/paymentHash',
      bounty.id
    );
    return;
  }
  const invoice = bounty.invoice;
  const panel = vscode.window.createWebviewPanel(
    'bountyInvoice',
    `Bounty: ${test.label} (${bounty.amountSats} sats)`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, localResourceRoots: [], enableForms: false, enableCommandUris: false }
  );
  let noticeHtml = '';
  try {
    // Generate QR code as SVG
    const invoiceQrSvg = await new Promise<string>((resolve, reject) => {
      toString(
        invoice,
        { type: 'svg', errorCorrectionLevel: 'M' },
        (err: Error | null | undefined, svg: string) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(svg);
        }
      );
    });

    const nostrHandle = await getNostrUserHandle();
    const userPubkey = await getNostrUserPubkey();

    if (nostrHandle) {
      noticeHtml = `
    <div class="success-notice">
      Connected to Nostr as <strong>${escapeHtml(nostrHandle)}</strong>.<br>
      Not you? Press <span class="shortcut">Ctrl+Alt+N</span> (Cmd+Alt+N on Mac) to create and review bounties under a different Nostr identity.
    </div>
  `;
    } else if (!nostrHandle && userPubkey) {
      const shortPubkey = userPubkey.slice(0, 10) + '...' + userPubkey.slice(-6);
      noticeHtml = `
        <div class="success-notice">
          Connected to Nostr with pubkey <strong>${escapeHtml(shortPubkey)}</strong>.<br>
          To disconnect or sign bounties under a different Nostr user, press <span class="shortcut">Ctrl+Alt+N</span> (Cmd+Alt+N on Mac).
        </div>
      `;
    } else {
      noticeHtml = `
    <div class="info-notice">
      This bounty is anonymous.<br>
      <span class="shortcut">Connect to Nostr using keyboard shortcut Ctrl+Alt+N (Cmd+Alt+N on Mac)</span><br>
      to review any claims.
    </div>
  `;
    }

    // Set Webview HTML
    const nonce = getNonce();
    const escapedInvoice = escapeHtml(invoice);
    panel.webview.html = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bounty Invoice</title>
    <style>
      body {
        font-family: monospace;
        padding: 20px;
        background: #f5f5f5;
        color: #333;
        margin: 0;
      }
      h2 {
        text-align: center;
        color: #2c3e50;
      }
      p {
        text-align: center;
      }
      .qr-container {
        text-align: center;
        margin: 20px 0;
      }
      .qr-container svg {
        max-width: 250px;
        height: auto;
      }
      button {
        display: block;
        margin: 10px auto;
        padding: 10px 20px;
        background: #3498db;
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
      }
      button:hover {
        background: #2980b9;
      }
      .info-notice, .success-notice {
        padding: 12px;
        margin: 20px 0;
        border-radius: 4px;
        text-align: center;
        line-height: 1.5;
      }
      .info-notice {
        background: #e3f2fd;
        border: 1px solid #bbdefb;
        color: #0d47a1;
      }
      .success-notice {
        background: #e8f5e9;
        border: 1px solid #c8e6c9;
        color: #1b5e20;
      }
      .shortcut {
        font-weight: bold;
        color: #1e88e5;
      }
      .status { text-align: center; font-weight: bold; margin-top: 20px; }
    </style>
  </head>
  <body>
    <h2>Scan to fund bounty (${bounty.amountSats} sats)</h2>
    ${noticeHtml}
    <div class="qr-container">
      ${invoiceQrSvg}
    </div>
    <button id="copyBtn">
      Copy Invoice
    </button>
    <p id="status" class="status">Waiting for payment via Lightning wallet...</p>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      document.getElementById('copyBtn').addEventListener('click', function() {
        navigator.clipboard.writeText('${escapedInvoice}').then(function() { alert('Invoice copied!'); });
      });
      window.addEventListener('message', event => {
        const msg = event.data;
        if (msg.command === 'updateStatus') {
          document.getElementById('status').innerText = msg.text;
          document.getElementById('status').style.color = msg.color || '#333';
        } else if (msg.command === 'paid') {
          document.getElementById('status').innerText = 'Payment received! Closing...';
          document.getElementById('status').style.color = 'green';
          setTimeout(() => vscode.postMessage({command:'close'}), 3000);
        }
      });
    </script>
  </body>
  </html>
`;

    // Listen for messages from Webview
    const messageDisposable = panel.webview.onDidReceiveMessage((message) => {
      if (message.command === 'close') {
        panel.dispose();
      }
    });

    // Clean up on panel close
    panel.onDidDispose(() => messageDisposable.dispose());

    // Start polling for payment status
    const pollInterval = setInterval(async () => {
      try {
        const isPaid = await checkPaidStatus(bounty.paymentHash as string); // your existing check logic or helper

        if (isPaid) {
          clearInterval(pollInterval);
          panel.webview.postMessage({ command: 'paid' });
          bounty.invoicePaid = true;
          bounties.set(test.id, bounty);
          onBountiesChangedEmitter.fire();
          vscode.window.showInformationMessage(
            `Payment received! ${bounty.amountSats} sats funded.`
          );
          const syncSuccess = await updatePaidStatus(bounty.id);
          if (!syncSuccess) {
            console.error('[Invoice Poll] Invoice paid, but failed to sync with DB.');
          }
        }
      } catch (err) {
        console.error('[Invoice Poll] Error checking payment:', err);
      }
    }, 10000); // Poll every 10 seconds

    // stop polling when panel closes
    panel.onDidDispose(() => {
      clearInterval(pollInterval);
    });
  } catch (err) {
    const errMsg = escapeHtml(err instanceof Error ? err.message : 'Unknown error');
    panel.webview.html = `
      <h1>Error generating QR code</h1>
      <p>${errMsg}</p>
    `;
    console.error('[setupInvoiceWebview] QR generation error:', err);
  }
}
