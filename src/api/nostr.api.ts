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
  getNostrBunkerPointer,
  getNostrClientSecret,
  getNostrRelays,
  getNostrUserHandle,
  getNostrUserPubkey,
  setNostrAuthEvent,
  setNostrBunkerPointer,
  setNostrClientSecret,
  setNostrUserHandle,
  setNostrUserPubkey,
} from '../state.js';
import type { BunkerPointer } from 'nostr-tools/nip46';
import type { VerifiedEvent } from 'nostr-tools';

/** Content string for the write-scope credential required by the backend's `moneyAuth`. */
export const WRITE_AUTH_CONTENT = 'sattest-auth:write';

/**
 * Per-relay connection timeout. A relay that can't complete its WebSocket
 * handshake in this window is treated as down and skipped — it must not stall
 * the connect flow (see the Promise.allSettled dial in connectNostr).
 */
const RELAY_CONNECT_TIMEOUT_MS = 5000;

/**
 * How long a kind-0 profile lookup waits for relays to answer.
 *
 * `pool.get` resolves as soon as every queried relay sends EOSE, so without a
 * `maxWait` the fastest empty relay decides the result: the promise settles
 * `null` before a slower relay that actually holds the profile can reply. That
 * was a major cause of the "Connected as <hex>" banner.
 */
const PROFILE_LOOKUP_MAX_WAIT_MS = 4000;

/**
 * Resolve a display handle (kind-0 `name` / `nip05` / `username`) for `pubkey`.
 *
 * Returns `undefined` when no profile is found or it carries no usable name.
 * Callers MUST treat that as "unknown" and never persist a placeholder — the
 * stored handle has no refresh path other than `refreshNostrHandleIfStale`, so
 * a persisted fallback sticks around and shows hex in the banner forever.
 *
 * The `@` prefix is applied only to a genuinely resolved name, so a pubkey
 * rendering is never dressed up as a handle.
 */
async function fetchProfileHandle(
  pool: SimplePool,
  relays: string[],
  pubkey: string
): Promise<string | undefined> {
  try {
    const event = await pool.get(
      relays,
      { kinds: [0], authors: [pubkey] },
      { maxWait: PROFILE_LOOKUP_MAX_WAIT_MS }
    );
    if (!event) {
      return undefined;
    }
    const profile = JSON.parse(event.content || '{}');
    const raw = profile.name || profile.nip05 || profile.username;
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return undefined;
    }
    const name = raw.trim().slice(0, 100);
    return name.startsWith('@') ? name : `@${name}`;
  } catch {
    // Malformed profile JSON, or the lookup itself failed — treat as unknown.
    return undefined;
  }
}

/** Display-only rendering of a pubkey, used when no handle could be resolved. */
function formatPubkeyForDisplay(pubkey: string): string {
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}

/**
 * True when a stored handle is really a pubkey rendering rather than a name.
 *
 * Recognises the fallback shapes older builds persisted (`<first10>...`, with
 * or without an `@`) plus the current display form, so installs already
 * poisoned by a failed lookup can self-heal instead of showing hex forever.
 */
export function isPubkeyFallbackHandle(handle: string, pubkey: string): boolean {
  const base = handle.startsWith('@') ? handle.slice(1) : handle;
  if (base.trim().length === 0) {
    return true;
  }
  if (base === `${pubkey.slice(0, 10)}...` || base === formatPubkeyForDisplay(pubkey)) {
    return true;
  }
  // Defensive: any pure-hex string that prefixes the pubkey is a slice of it,
  // not a name (real handles aren't hex prefixes of their own pubkey).
  const trimmed = base.replace(/[.…]+$/g, '').toLowerCase();
  return /^[0-9a-f]{4,}$/.test(trimmed) && pubkey.toLowerCase().startsWith(trimmed);
}

export async function connectNostr(
  context: vscode.ExtensionContext,
  onBountiesChangedEmitter: vscode.EventEmitter<void>,
  opts?: {
    /** Call-to-action banner shown above the QR (e.g. session-expired notices). */
    noticeMessage?: string;
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

  // Paint a bare "connecting" page immediately so the panel is never blank
  // while relays are dialed (the fuller placeholder with banners repaints
  // below, before the QR is revealed).
  panel.webview.html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
            <title>Connect to Nostr</title>
            <style>body { font-family: monospace; padding: 20px; background: #f5f5f5; color: #333; text-align: center; }</style>
        </head>
        <body>
            <h2>Connect to Nostr</h2>
            <p>Connecting to Nostr relays…</p>
        </body>
        </html>
    `;

  // Dial the configured relays in parallel, tolerating individual failures —
  // a single dead or slow relay must not kill the whole connect flow. Only
  // relays that actually connected are advertised in the nostrconnect:// URI,
  // so the signer never publishes its response somewhere we aren't listening.
  const relayResults = await Promise.allSettled(
    relays.map((url) => pool.ensureRelay(url, { connectionTimeout: RELAY_CONNECT_TIMEOUT_MS }))
  );
  const liveRelays = relays.filter((_, i) => relayResults[i].status === 'fulfilled');
  const failedRelays = relays.filter((_, i) => relayResults[i].status === 'rejected');
  if (failedRelays.length > 0) {
    console.warn(
      `[connectNostr] Skipping unreachable relays: ${failedRelays.join(', ')} — continuing with ${liveRelays.length} relay(s)`
    );
  }
  if (liveRelays.length === 0) {
    panel.webview.html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
            <title>Connect to Nostr</title>
            <style>
            body { font-family: monospace; padding: 20px; background: #f5f5f5; color: #333; text-align: center; }
            .error { background: #fdecea; border: 1px solid #f5c6cb; color: #721c24; padding: 12px; border-radius: 4px; line-height: 1.5; }
            </style>
        </head>
        <body>
            <h2>Connect to Nostr</h2>
            <div class="error">Could not reach any configured Nostr relay:<br>${relays.map(escapeHtml).join('<br>')}<br><br>Check your network, or adjust the <b>sattest.nostrRelays</b> setting.</div>
        </body>
        </html>
    `;
    vscode.window.showErrorMessage(
      `Could not reach any configured Nostr relay (${relays.join(', ')}). Check your network or the sattest.nostrRelays setting.`
    );
    return undefined;
  }

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
    relays: liveRelays,
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

  // Resolve the connected identity once, for the green "Connected as" banner.
  const currentHandle = await getNostrUserHandle();
  const currentPubkey = await getNostrUserPubkey();
  const identityDisplay = currentPubkey
    ? currentHandle
      ? currentHandle.startsWith('@') ? currentHandle : `@${currentHandle}`
      : `${currentPubkey.slice(0, 8)}…${currentPubkey.slice(-4)}`
    : undefined;

  // Optional call-to-action banner — shown when the panel is opened mid-flow to
  // recover an expired session (e.g. completing an NWC wallet connection).
  // Never tied to whichever identity was previously connected: any Nostr
  // identity may complete this flow, so the notice stays generic.
  const noticeText = opts?.noticeMessage;
  const noticeBannerHtml = noticeText
    ? `<div class="notice-action">${escapeHtml(noticeText)}</div>`
    : '';

  // Green "Connected as" banner — shown whenever an identity is already
  // connected, independent of the notice above.
  const connectedBannerHtml = identityDisplay
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
            Connecting Nostr to Sattest allows you to create, claim, and approve bounties.
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
    liveRelays,
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
    const bunkerPointer: BunkerPointer = { pubkey: remoteSignerPubkey, relays, secret };
    const bunker = BunkerSigner.fromBunker(clientSecretBytes, bunkerPointer, { pool });

    // Persist the pointer (F4 hardening) so `signMoneyAuthEvent` can rebuild a
    // signer session on demand for each money-moving call, without asking the
    // user to scan the connect QR again every time.
    await setNostrBunkerPointer(JSON.stringify(bunkerPointer));

    const userPubkey = await bunker.getPublicKey();

    // Fetch profile (kind 0) for the handle.
    //
    // The handshake above legitimately needs *live-connected* relays, but a
    // metadata read does not: querying only `relays` (the ones that won the 5s
    // connect race) systematically biased this lookup toward the NIP-46 signer
    // relay — which answers fastest and is the least likely to hold a kind-0 —
    // so the profile came back empty and the banner showed hex. Query the full
    // configured set as well, and let `maxWait` give a slower general relay
    // that actually has the profile a chance to answer.
    const profileRelays = Array.from(new Set([...relays, ...getNostrRelays()]));
    const resolvedHandle = await fetchProfileHandle(pool, profileRelays, userPubkey);

    // Decide what to display *and* what (if anything) to persist. Never store
    // a pubkey fallback: `setNostrUserHandle` is the only write site and there
    // is no refresh path at connect time, so one miss would otherwise poison
    // the banner permanently.
    const previousPubkey = await getNostrUserPubkey();
    const previousHandle = await getNostrUserHandle();
    let userHandle: string;
    if (resolvedHandle) {
      userHandle = resolvedHandle;
    } else if (
      previousPubkey === userPubkey &&
      previousHandle &&
      !isPubkeyFallbackHandle(previousHandle, userPubkey)
    ) {
      // Same identity, lookup missed (slow/unreachable metadata relay) — keep
      // the good handle we resolved on an earlier connect rather than
      // regressing to hex.
      userHandle = previousHandle;
    } else {
      // Unknown, or a *different* identity we couldn't name. Render the pubkey
      // for display only — and make sure the previous identity's handle can't
      // bleed through onto this one.
      userHandle = formatPubkeyForDisplay(userPubkey);
    }

    // Sign the read-scope auth credential for backend API authentication
    // (NIP-42 kind 22242, M1 hardening). Signed once at connect time and
    // reused for the lifetime of its freshness window — reads are
    // non-destructive, so avoiding a signer round-trip on every read is worth
    // the bounded replay window (`content: 'sattest-auth'`, accepted by
    // nostrAuth).
    //
    // The write-scope credential (`content: 'sattest-auth:write'`, required
    // by moneyAuth) is NOT signed here. Since moneyAuth requires a
    // server-issued single-use nonce (F4 hardening), a write credential must
    // be signed fresh per money-moving call — see `signMoneyAuthEvent` below,
    // which reuses the persisted bunker pointer to do that on demand.
    //
    // The `relay` tag binds the credential to this backend (AUTH_AUDIENCE): a
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

    await setNostrUserPubkey(userPubkey);
    // Persist only a real name. When the lookup missed we either kept the
    // previously-resolved handle for this same identity (already stored, so
    // nothing to write) or we're showing a pubkey rendering — storing that
    // would make the fallback permanent, and for a *new* identity it must also
    // clear the previous identity's handle so it can't bleed through.
    if (resolvedHandle) {
      await setNostrUserHandle(resolvedHandle);
    } else if (previousPubkey !== userPubkey) {
      await setNostrUserHandle('');
    }

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

/**
 * Self-heal a stored handle that is really a pubkey rendering.
 *
 * Builds shipped before the profile-lookup fix persisted a hex fallback
 * whenever the kind-0 query missed, and connect is the only other write site —
 * so an affected install keeps showing hex until the user happens to re-pair.
 * Called fire-and-forget on activation: when the stored handle is missing or
 * looks like a pubkey, re-resolve it against the full configured relay set and
 * store the real name if one turns up.
 *
 * Never overwrites a good handle and never persists a fallback, so it's safe to
 * run on every activation.
 *
 * @returns the refreshed handle, or `undefined` when nothing changed.
 */
export async function refreshNostrHandleIfStale(): Promise<string | undefined> {
  const pubkey = await getNostrUserPubkey();
  if (!pubkey) {
    return undefined; // not connected — nothing to refresh
  }
  const stored = await getNostrUserHandle();
  if (stored && !isPubkeyFallbackHandle(stored, pubkey)) {
    return undefined; // already a real handle
  }

  const relays = getNostrRelays();
  const pool = new SimplePool();
  try {
    const handle = await fetchProfileHandle(pool, relays, pubkey);
    if (!handle) {
      return undefined;
    }
    await setNostrUserHandle(handle);
    return handle;
  } catch {
    return undefined;
  } finally {
    try {
      pool.close(relays);
    } catch {
      /* already closed */
    }
  }
}

/**
 * Signs a fresh write-scope NIP-42 auth event bound to `nonce` (F4
 * hardening). The backend's `moneyAuth` middleware requires a server-issued,
 * single-use nonce on every money-moving call, so — unlike the read
 * credential — this can't be signed once and cached; it's minted per call.
 *
 * Rebuilds a `BunkerSigner` from the persisted client secret + bunker
 * pointer (saved by `connectNostr`) rather than reusing a long-lived session
 * object, since the extension may call this long after the original connect
 * flow completed and doesn't keep a signer connection open in the meantime.
 *
 * Throws if no identity is connected yet — callers (see `nostr-auth.ts`)
 * treat that the same as an expired session and can trigger the same
 * interactive-reconnect flow used elsewhere.
 */
export async function signMoneyAuthEvent(nonce: string): Promise<VerifiedEvent> {
  const clientSecretHex = await getNostrClientSecret();
  const bunkerPointerJson = await getNostrBunkerPointer();
  if (!clientSecretHex || !bunkerPointerJson) {
    throw new Error(
      'Nostr authentication required (write scope). Use "Connect Nostr" (Ctrl+Alt+N) first.'
    );
  }

  const clientSecretBytes = hexToBytes(clientSecretHex);
  const bunkerPointer: BunkerPointer = JSON.parse(bunkerPointerJson);
  const pool = new SimplePool();
  try {
    const bunker = BunkerSigner.fromBunker(clientSecretBytes, bunkerPointer, { pool });
    const backendUrl = getBackendUrl();
    return await bunker.signEvent({
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['challenge', WRITE_AUTH_CONTENT],
        ['nonce', nonce],
        ['relay', backendUrl],
      ],
      content: WRITE_AUTH_CONTENT,
    });
  } finally {
    pool.close(bunkerPointer.relays);
  }
}
