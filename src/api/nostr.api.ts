import * as crypto from 'crypto';
import {
  generateSecretKey, // Uint8Array
  getPublicKey,
  SimplePool,
} from 'nostr-tools';
import * as vscode from 'vscode';
import { BunkerSigner, createNostrConnectURI } from 'nostr-tools/nip46';

import { bytesToHex } from 'nostr-tools/utils';
import * as QRCode from 'qrcode';

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
import {
  getNostrClientSecret,
  getNostrRelays,
  setNostrAuthEvent,
  setNostrClientSecret,
  setNostrUserHandle,
  setNostrUserPubkey,
} from '../state.js';

export async function connectNostr(
  context: vscode.ExtensionContext,
  onBountiesChangedEmitter: vscode.EventEmitter<void>
): Promise<{ userPubkey: string; userHandle: string } | undefined> {
  const pool = new SimplePool();

  const relays = getNostrRelays();
  // Create and show the panel immediately
  const panel = vscode.window.createWebviewPanel(
    'nostrConnect',
    'Connect to Nostr',
    vscode.ViewColumn.Beside,
    { enableScripts: true, localResourceRoots: [], enableForms: false, enableCommandUris: false }
  );

  await Promise.all(relays.map((url) => pool.ensureRelay(url)));
  // Load or generate client secret
  let clientSecretHex = await getNostrClientSecret();
  let clientSecretBytes: Uint8Array;

  if (clientSecretHex) {
    clientSecretBytes = hexToBytes(clientSecretHex);
  } else {
    clientSecretBytes = generateSecretKey();
    clientSecretHex = bytesToHex(clientSecretBytes);
    await setNostrClientSecret(clientSecretHex);
  }

  const clientPubkey = getPublicKey(clientSecretBytes);

  // Create URI
  const connectionUri = createNostrConnectURI({
    clientPubkey,
    relays,
    secret: bytesToHex(generateSecretKey()),
    name: 'Sattest',
  });

  // Generate QR
  let qrSvg = '';
  try {
    qrSvg = await QRCode.toString(connectionUri, { type: 'svg', errorCorrectionLevel: 'M' });
  } catch (err) {
    qrSvg = '<p>QR generation failed – copy URI below</p>';
  }

  // Initial HTML
  const nonce = getNonce();
  const escapedUri = escapeHtml(connectionUri);
  panel.webview.html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Connect to Nostr</title>
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
            .notice {
                background: #e3f2fd;
                border: 1px solid #bbdefb;
                color: #0d47a1;
                padding: 12px;
                margin: 20px 0;
                border-radius: 4px;
                text-align: center;
                line-height: 1.5;
            }
            .status {
                text-align: center;
                font-weight: bold;
                margin-top: 20px;
            }
            </style>
        </head>
        <body>
            <h2>Connect to Nostr</h2>
            <p style="text-align:center;">Scan this QR with Primal, Amber, Alby, Nostrum or any NIP-46 signer, or copy the URI:</p>
            <div class="qr-container">
            ${qrSvg}
            </div>
            <button id="copyUriBtn">
            Copy URI
            </button>
            <script nonce="${nonce}">
              document.getElementById('copyUriBtn').addEventListener('click', function() {
                navigator.clipboard.writeText('${escapedUri}').then(function() { alert('URI copied!'); });
              });
            </script>

            <div class="notice">
            This connects your Nostr identity to Sattest, which allows you to create, claim, and approve bounties. If the connection is not working, end the remote session and try again.
            </div>

            <p id="status" class="status">Waiting for approval in your signer app...</p>
            <script nonce="${nonce}">
              const uri = ${JSON.stringify(connectionUri)};
              document.getElementById('copyUriBtn').addEventListener('click', function() {
                navigator.clipboard.writeText(uri).then(function() { alert('URI copied!'); });
              });
            </script>
        </body>
        </html>
    `;

  const nostrConnection = await resolveNostrInfoFromBunkerSigner(
    clientSecretBytes,
    connectionUri,
    relays,
    pool,
    context,
    panel
  );
  if (!nostrConnection) {
    return;
  }
  onBountiesChangedEmitter.fire();
  return nostrConnection;
}

/**
 * Resolves Nostr user pubkey and handle from a BunkerSigner.
 * Updates panel status and closes it automatically on success/error.
 */
export async function resolveNostrInfoFromBunkerSigner(
  clientSecretBytes: Uint8Array,
  connectionUri: string,
  relays: string[],
  pool: SimplePool,
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel
): Promise<{ userPubkey: string; userHandle: string } | undefined> {
  const updateStatus = (text: string, color = '#333') => {
    panel.webview.html = panel.webview.html.replace(
      /<p id="status".*?<\/p>/,
      `<p id="status" style="color:${escapeHtml(color)};">${escapeHtml(text)}</p>`
    );
  };

  const closePanel = (delay = 2000) => {
    setTimeout(() => panel.dispose(), delay);
  };

  // Handle manual close from Webview
  const disposable = panel.webview.onDidReceiveMessage((msg) => {
    if (msg.command === 'close') {
      closePanel(0);
    }
  });

  try {
    updateStatus('Waiting for signer approval...', '#007acc');

    const bunker = await Promise.race([
      BunkerSigner.fromURI(clientSecretBytes, connectionUri, { pool }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 90000)),
    ]);

    const userPubkey = await bunker.getPublicKey();

    // Fetch profile (kind 0) for handle
    const event = await pool.get(relays, {
      kinds: [0],
      authors: [userPubkey],
    });

    let userHandle = userPubkey.slice(0, 10) + '...'; // fallback

    if (event) {
      try {
        const profile = JSON.parse(event.content || '{}');
        const raw = profile.name || profile.nip05 || profile.username;
        if (typeof raw === 'string' && raw.length > 0) {
          userHandle = raw.slice(0, 100);
        }
      } catch {
        // Malformed profile JSON – keep fallback handle
      }
      if (!userHandle.startsWith('@')) {
        userHandle = `@${userHandle}`;
      }
    }

    // Sign an auth event for backend API authentication (NIP-42 kind 22242)
    updateStatus('Signing auth credential...', '#007acc');
    const signedAuthEvent = await bunker.signEvent({
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['challenge', 'sattest-auth']],
      content: 'sattest-auth',
    });
    await setNostrAuthEvent(JSON.stringify(signedAuthEvent));

    // Save both
    await setNostrUserPubkey(userPubkey);
    await setNostrUserHandle(userHandle);

    updateStatus(`Connected as ${userHandle}! Closing...`, 'green');
    vscode.window.showInformationMessage(`Connected to Nostr: ${userHandle}`);

    closePanel(2500);

    return { userPubkey, userHandle };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Nostr Connect] Failed:', msg);

    updateStatus(`Failed: ${msg}`, 'red');
    vscode.window.showErrorMessage(`Nostr connection failed: ${msg}`);

    closePanel(4000);

    return undefined;
  } finally {
    disposable.dispose();
  }
}

// Helper: hex to bytes
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}
