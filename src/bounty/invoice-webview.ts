import * as vscode from 'vscode';
import { toString } from 'qrcode';
import { BountyInfo } from './bounty.types.js';
import { getNostrUserHandle, getNostrUserPubkey } from '../state.js';
import { escapeHtml, getNonce } from '../util/html.js';
import { checkPaidStatus, updatePaidStatus } from '../api/bounty.api.js';

/**
 * Opens the custodial (LNbits) funding panel: renders the invoice as a QR the
 * creator can scan, then polls the backend until the invoice is paid, updating
 * the panel and the local bounty state when it lands.
 *
 * Only reachable on the custodial funding path (NWC bounties have no invoice or
 * payment hash); callers short-circuit for those, and this guards defensively.
 */
export async function showBountyInvoicePanel(
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
      '[showBountyInvoicePanel] Skipping panel — bounty has no invoice/paymentHash',
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
    panel.webview.html = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
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
      // JSON-encoded string literal (not HTML-escaped interpolation) so the
      // invoice can't break out of the JS string context.
      const invoice = ${JSON.stringify(invoice)};
      document.getElementById('copyBtn').addEventListener('click', function() {
        navigator.clipboard.writeText(invoice).then(function() { alert('Invoice copied!'); });
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
