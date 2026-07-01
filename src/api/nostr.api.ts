import * as crypto from 'crypto';
import {
  generateSecretKey, // Uint8Array
  getPublicKey,
  nip04,
  nip44,
  SimplePool,
} from 'nostr-tools';
import * as vscode from 'vscode';
import { BunkerSigner, createNostrConnectURI } from 'nostr-tools/nip46';

import { bytesToHex } from 'nostr-tools/utils';
import * as QRCode from 'qrcode';
import { getBackendUrl } from './config.js';

/** NIP-46 messages travel as kind 24133 (ephemeral — relays don't store them). */
const NOSTR_CONNECT_KIND = 24133;

/**
 * Waits for the remote signer's "connect" response after the user scans our
 * nostrconnect:// QR. Resolves with the signer's pubkey.
 *
 * This replaces nostr-tools' `BunkerSigner.fromURI` handshake, whose matcher is
 * too strict for real-world signers and silently drops their responses — the
 * root cause of the "have to connect twice" bug:
 *   • it only decrypts NIP-44, but several signers (Primal among them) encrypt
 *     the connect response with NIP-04 → decrypt throws → event dropped;
 *   • it only accepts `result === <secret>`, but many signers reply with the
 *     legacy `result: "ack"` → event dropped.
 * We accept both encodings and both reply shapes, and log anything we drop so
 * the next interop quirk is diagnosable instead of silent.
 */
function waitForSignerHandshake(
  pool: SimplePool,
  relays: string[],
  clientSecretBytes: Uint8Array,
  clientPubkey: string,
  secret: string,
  timeoutMs = 90000
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      try {
        sub.close();
      } catch {
        /* already closed */
      }
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('Timeout'))), timeoutMs);

    const sub = pool.subscribe(
      relays,
      { kinds: [NOSTR_CONNECT_KIND], '#p': [clientPubkey] },
      {
        onevent: (event) => {
          if (done) {
            return;
          }
          // Decrypt NIP-44 first (current spec), fall back to NIP-04 (what a
          // number of signers still send for the connect response).
          let payload: string;
          try {
            payload = nip44.decrypt(
              event.content,
              nip44.getConversationKey(clientSecretBytes, event.pubkey)
            );
          } catch {
            try {
              payload = nip04.decrypt(clientSecretBytes, event.pubkey, event.content);
            } catch {
              console.warn(
                '[Nostr Connect] Dropping undecryptable kind-24133 event from',
                event.pubkey
              );
              return;
            }
          }
          try {
            const response = JSON.parse(payload);
            // Spec says echo the secret; many signers send the legacy "ack".
            // Accept both — the success view shows the connected identity, so
            // the user can see exactly who paired.
            if (response.result === secret || response.result === 'ack') {
              finish(() => resolve(event.pubkey));
            } else if (response.error) {
              console.warn('[Nostr Connect] Signer reported error during connect:', response.error);
            } else {
              console.warn(
                '[Nostr Connect] Ignoring connect response with unexpected result:',
                response.result
              );
            }
          } catch (e) {
            console.warn('[Nostr Connect] Malformed connect payload:', e);
          }
        },
        onclose: () =>
          finish(() => reject(new Error('Relay subscription closed before the signer responded'))),
      }
    );
  });
}

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

/**
 * Replace the Connect to Nostr panel with a minimal "you're connected" view
 * after a successful pairing. Strips the QR / copy-URI / scan instructions so
 * the panel can't be re-used to pair a third identity in the seconds before
 * it auto-closes.
 *
 * Self-contained HTML (no script, no external resources) so it works under
 * the panel's existing CSP without further nonces.
 */
function renderConnectedSuccess(panel: vscode.WebviewPanel, userHandle: string): void {
  const safeHandle = escapeHtml(userHandle);
  panel.webview.html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Connected to Nostr</title>
      <style>
        body {
          font-family: monospace;
          padding: 20px;
          background: #f5f5f5;
          color: #333;
          margin: 0;
        }
        h2 { text-align: center; color: #2c3e50; }
        .connected {
          background: #e8f5e9;
          border: 1px solid #a5d6a7;
          color: #1b5e20;
          padding: 12px;
          margin: 0 0 20px 0;
          border-radius: 4px;
          text-align: center;
          font-weight: bold;
          line-height: 1.5;
        }
        .closing {
          text-align: center;
          color: #555;
          margin-top: 24px;
        }
      </style>
    </head>
    <body>
      <h2>Connect to Nostr</h2>
      <div class="connected">Connected as ${safeHandle}</div>
      <p class="closing">Closing in a few seconds…</p>
    </body>
    </html>
  `;
}
import {
  getNostrClientSecret,
  getNostrRelays,
  getNostrUserHandle,
  getNostrUserPubkey,
  setNostrAuthEvent,
  setNostrWriteAuthEvent,
  setNostrClientSecret,
  setNostrUserHandle,
  setNostrUserPubkey,
} from '../state.js';

export async function connectNostr(
  context: vscode.ExtensionContext,
  onBountiesChangedEmitter: vscode.EventEmitter<void>,
  opts?: {
    /** Generic call-to-action shown when no identity is connected. */
    noticeMessage?: string;
    /**
     * Identity-aware variant. When a Nostr identity is already connected and
     * this is provided, it's used instead of `noticeMessage` (and the separate
     * green "Connected as" banner is suppressed). The caller owns the wording;
     * connectNostr supplies the handle/short-pubkey.
     */
    noticeMessageWithIdentity?: (identity: string) => string;
  }
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

  // Resolve the connected identity once — the handle if known, otherwise a
  // shortened pubkey. Used by both the green "Connected as" banner and the
  // identity-aware notice below.
  const currentHandle = await getNostrUserHandle();
  const currentPubkey = await getNostrUserPubkey();
  const identityDisplay = currentPubkey
    ? currentHandle
      ? currentHandle.startsWith('@') ? currentHandle : `@${currentHandle}`
      : `${currentPubkey.slice(0, 8)}…${currentPubkey.slice(-4)}`
    : undefined;

  // Optional call-to-action banner — shown when the panel is opened mid-flow to
  // recover an expired session (e.g. completing an NWC wallet connection). When
  // an identity is connected and the caller provides an identity-aware variant,
  // fold the handle/pubkey into the notice itself rather than also showing the
  // separate green "Connected as" banner.
  const noticeText =
    identityDisplay && opts?.noticeMessageWithIdentity
      ? opts.noticeMessageWithIdentity(identityDisplay)
      : opts?.noticeMessage;
  const noticeBannerHtml = noticeText
    ? `<div class="notice-action">${escapeHtml(noticeText)}</div>`
    : '';

  // Green "Connected as" banner — only when we're NOT already showing the
  // notice (the notice carries the identity in the re-auth flow, so a second
  // banner would be redundant).
  const connectedBannerHtml =
    identityDisplay && !noticeText
      ? `<div class="connected">Connected as ${escapeHtml(identityDisplay)}</div>`
      : '';

  // Full QR view — built now but NOT painted yet. We reveal it only after the
  // signer-response subscription has had a moment to go live (see below), so
  // the user's first scan lands on a warm listener.
  const nonce = getNonce();
  const qrHtml = `
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
            .connected {
                background: #e8f5e9;
                border: 1px solid #a5d6a7;
                color: #1b5e20;
                padding: 12px;
                margin: 0 0 20px 0;
                border-radius: 4px;
                text-align: center;
                font-weight: bold;
                line-height: 1.5;
            }
            .notice-action {
                background: #fff3cd;
                border: 1px solid #ffe69c;
                color: #664d03;
                padding: 12px;
                margin: 0 0 20px 0;
                border-radius: 4px;
                text-align: center;
                font-weight: bold;
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
            ${noticeBannerHtml}
            ${connectedBannerHtml}
            <p style="text-align:center;">Scan this QR with Primal, Amber, Alby, Nostrum or any NIP-46 signer, or copy the URI:</p>
            <div class="qr-container">
            ${qrSvg}
            </div>
            <button id="copyUriBtn">
            Copy URI
            </button>

            <div class="notice">
            This connects your Nostr identity to Sattest, which allows you to create, claim, and approve bounties. If the connection is not working, end the remote session and try again.
            </div>

            <p id="status" class="status">Waiting for approval in your signer app...</p>
            <script nonce="${nonce}">
              // Pass the URI as a JSON-encoded string literal (not HTML-escaped
              // interpolation) so it can't break out of the JS string context.
              const uri = ${JSON.stringify(connectionUri)};
              document.getElementById('copyUriBtn').addEventListener('click', function() {
                navigator.clipboard.writeText(uri).then(function() { alert('URI copied!'); });
              });
            </script>
        </body>
        </html>
    `;

  // Paint a lightweight placeholder first. The QR is revealed by the resolver
  // *after* the signer-response subscription is live (the nostrconnect://
  // listener uses limit:0 — only new events — so a response that arrives before
  // the subscription is active is lost, which is the "have to connect twice"
  // bug). Keep the same banners for continuity.
  panel.webview.html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Connect to Nostr</title>
            <style>
            body { font-family: monospace; padding: 20px; background: #f5f5f5; color: #333; text-align: center; }
            h2 { color: #2c3e50; }
            .notice-action { background: #fff3cd; border: 1px solid #ffe69c; color: #664d03; padding: 12px; margin: 0 0 20px; border-radius: 4px; font-weight: bold; line-height: 1.5; }
            .connected { background: #e8f5e9; border: 1px solid #a5d6a7; color: #1b5e20; padding: 12px; margin: 0 0 20px; border-radius: 4px; font-weight: bold; line-height: 1.5; }
            .status { margin-top: 24px; color: #555; }
            </style>
        </head>
        <body>
            <h2>Connect to Nostr</h2>
            ${noticeBannerHtml}
            ${connectedBannerHtml}
            <p class="status">Establishing secure connection…</p>
        </body>
        </html>
    `;

  const nostrConnection = await resolveNostrInfoFromBunkerSigner(
    clientSecretBytes,
    connectionUri,
    relays,
    pool,
    context,
    panel,
    () => {
      panel.webview.html = qrHtml;
    }
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
/**
 * Delay between starting the signer-response subscription and revealing the QR.
 * Gives the relay REQ time to go live so the user's first scan lands on a warm
 * listener (the nostrconnect:// listener is limit:0 — only new events). The
 * user takes longer than this to switch to their signer app, so it's invisible.
 */
const SUBSCRIPTION_SETTLE_MS = 750;

export async function resolveNostrInfoFromBunkerSigner(
  clientSecretBytes: Uint8Array,
  connectionUri: string,
  relays: string[],
  pool: SimplePool,
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  // Called once the signer-response subscription is live + settled, to reveal
  // the QR. Optional so direct unit tests can omit it.
  revealQr?: () => void,
  settleMs: number = SUBSCRIPTION_SETTLE_MS
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
    // Start the signer-response subscription FIRST (the relay REQ is
    // dispatched synchronously inside waitForSignerHandshake), so the listener
    // is live before the QR is scannable. Attach a noop catch so a rejection
    // during the settle window isn't flagged as unhandled — re-awaited below.
    const clientPubkey = getPublicKey(clientSecretBytes);
    const secret = new URL(connectionUri).searchParams.get('secret') ?? '';
    const handshakePromise = waitForSignerHandshake(
      pool,
      relays,
      clientSecretBytes,
      clientPubkey,
      secret
    );
    handshakePromise.catch(() => {
      /* re-awaited below */
    });

    // Give the subscription a moment to go live, THEN reveal the QR — so the
    // first scan can't beat the listener and get dropped (NIP-46 events are
    // ephemeral: relays only deliver them to already-live subscriptions).
    if (settleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, settleMs));
    }
    revealQr?.();
    updateStatus('Waiting for signer approval...', '#007acc');

    const remoteSignerPubkey = await handshakePromise;

    // Handshake accepted — build the signer session directly from the bunker
    // pointer. Unlike fromURI this doesn't re-wait for anything; it just wires
    // up the conversation with the pubkey that answered our QR.
    const bunker = BunkerSigner.fromBunker(
      clientSecretBytes,
      { pubkey: remoteSignerPubkey, relays, secret },
      { pool }
    );

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

    // Sign two scope-separated auth credentials for backend API authentication
    // (NIP-42 kind 22242, M1 hardening). Signing both at connect time avoids
    // requiring an interactive signer round-trip on every write operation.
    //
    // READ credential  (`content: 'sattest-auth'`)       — accepted by nostrAuth
    // WRITE credential (`content: 'sattest-auth:write'`) — required by moneyAuth
    //
    // The `relay` tag binds each credential to this backend (AUTH_AUDIENCE): a
    // harvested event can't be replayed against a different server.
    const backendUrl = getBackendUrl();
    updateStatus('Signing auth credentials...', '#007acc');
    const signedAuthEvent = await bunker.signEvent({
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['challenge', 'sattest-auth'],
        ['relay', backendUrl],
      ],
      content: 'sattest-auth',
    });
    await setNostrAuthEvent(JSON.stringify(signedAuthEvent));

    const signedWriteAuthEvent = await bunker.signEvent({
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['challenge', 'sattest-auth:write'],
        ['relay', backendUrl],
      ],
      content: 'sattest-auth:write',
    });
    await setNostrWriteAuthEvent(JSON.stringify(signedWriteAuthEvent));

    // Save both
    await setNostrUserPubkey(userPubkey);
    await setNostrUserHandle(userHandle);

    // Replace the entire panel body with a minimal success view: the green
    // "Connected as @handle" banner updated to the *new* identity, and a
    // "Closing in a few seconds…" status. The QR / copy-URI / scan
    // instructions are gone — leaving them up while we tear down would invite
    // the user to scan again with yet another identity. We deliberately keep
    // the panel visible briefly so the swap is unambiguous.
    renderConnectedSuccess(panel, userHandle);
    vscode.window.showInformationMessage(`Connected to Nostr: ${userHandle}`);

    closePanel(4000);

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
