import { escapeHtml, getNonce } from '../util/html.js';
import {
  generateSecretKey, // Uint8Array
  getPublicKey,
  SimplePool,
} from 'nostr-tools';
import * as vscode from 'vscode';
import { BunkerSigner, createNostrConnectURI } from 'nostr-tools/nip46';

import { bytesToHex } from 'nostr-tools/utils';
import * as QRCode from 'qrcode';
import { getBackendUrl } from './config.js';
import {
  SIGNER_CONNECT_TIMEOUT_MS,
  SIGNER_WRITE_TIMEOUT_MS,
  SignerCancelledError,
  SignerTimeoutError,
} from './signer-errors.js';
import { renderConnectedSuccess } from './nostr-connect-webview.js';
import {
  waitForSignerHandshake,
  fetchProfileHandle,
  formatPubkeyForDisplay,
  isPubkeyFallbackHandle,
} from './nostr-signer.js';

// Re-exported so existing importers (and tests) keep resolving it from here.
export { isPubkeyFallbackHandle };

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
import {
  NOSTR_AUTH_KIND,
  READ_AUTH_CONTENT,
  WRITE_AUTH_CONTENT,
  REQUESTED_SIGNER_PERMS,
} from './nostr-protocol.js';

/**
 * Per-relay connection timeout. A relay that can't complete its WebSocket
 * handshake in this window is treated as down and skipped — it must not stall
 * the connect flow (see the Promise.allSettled dial in connectNostr).
 */
const RELAY_CONNECT_TIMEOUT_MS = 5000;

/**
 * How long a signer request may run before we reassure the user it's still
 * waiting on them. Well under the hard timeout: the point is to fill the
 * otherwise-silent gap where a user, seeing nothing happen, wanders off or
 * starts clicking other things. Fast auto-approvals settle well before this,
 * so the happy path never shows the notice.
 */
const SIGNER_SLOW_NOTICE_MS = 5000;

/** Human-facing title for the "waiting on your signer" progress notice. */
function slowSignerTitle(operation: string): string {
  return `Waiting for your Nostr signer — ${operation}…`;
}

/**
 * Bound a NIP-46 round-trip so an unresponsive signer fails loudly instead of
 * hanging the caller forever — and, if it runs long but hasn't timed out yet,
 * surface a self-dismissing, **cancellable** progress notice so the user knows
 * the ball is in their court (open nsec.app / Amber and approve) instead of
 * staring at nothing.
 *
 * The notice appears only after `SIGNER_SLOW_NOTICE_MS`, and is torn down the
 * instant the request settles — success, error, timeout, or cancel — so a fast
 * approval shows nothing and a slow one never leaves a stale toast behind.
 *
 * @param timeoutMs   Hard deadline; short for money/write ops, long for the
 *                    connect flow (which fires right after the user paired).
 * @param cancellable Whether the notice offers a Cancel button. Off during the
 *                    connect flow, where cancelling means aborting a pairing
 *                    that's mid-handshake.
 */
async function withSignerTimeout<T>(
  work: Promise<T>,
  operation: string,
  timeoutMs: number,
  { cancellable = true }: { cancellable?: boolean } = {}
): Promise<T> {
  // Resolves (never rejects) once we're done, whichever way it went. Drives the
  // dismissal of the progress notice.
  let finishNotice!: () => void;
  const noticeDone = new Promise<void>((resolve) => {
    finishNotice = resolve;
  });
  let settled = false;

  // Captured so the Cancel button (which only exists once the notice is shown)
  // can reject the outstanding race below.
  let rejectRace: ((reason: Error) => void) | undefined;

  const noticeTimer = setTimeout(() => {
    if (settled) {
      return; // already finished during the grace window — don't flash a notice
    }
    // A Notification-location progress spins until its task promise resolves;
    // we resolve `noticeDone` in the finally below, so it clears on its own.
    void vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: slowSignerTitle(operation),
        cancellable,
      },
      async (progress, token) => {
        progress.report({
          message: 'Open your signer (Primal / Profile / Remote Login) and approve the request.',
        });
        if (token.isCancellationRequested) {
          rejectRace?.(new SignerCancelledError(operation));
        }
        token.onCancellationRequested(() => rejectRace?.(new SignerCancelledError(operation)));
        await noticeDone;
      }
    );
  }, SIGNER_SLOW_NOTICE_MS);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A hand-rolled race (rather than Promise.race) so the Cancel handler above
    // can reject the same promise the caller is awaiting. The underlying `work`
    // keeps running — a NIP-46 request can't truly be cancelled — but the caller
    // is freed and the pool is torn down in its own finally, same as a timeout.
    return await new Promise<T>((resolve, reject) => {
      rejectRace = reject;
      work.then(resolve, reject);
      timer = setTimeout(() => reject(new SignerTimeoutError(operation, timeoutMs)), timeoutMs);
    });
  } finally {
    settled = true;
    clearTimeout(noticeTimer);
    if (timer) {
      clearTimeout(timer);
    }
    finishNotice(); // dismiss the progress notice if it was showing
  }
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
    pool.close(relays);
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
    // Ask for signing rights at pairing time so later money-moving calls don't
    // stall on an approval prompt the user never sees. See REQUESTED_SIGNER_PERMS.
    perms: REQUESTED_SIGNER_PERMS,
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

  // Green "Connected as" banner — shown when an identity is already connected.
  //
  // Mutually exclusive with the yellow refresh/reconnect notice: those two
  // contradict each other at a glance ("Connected as @alice" next to "Refresh
  // your Nostr connection"). When a notice is present the flow's whole point is
  // that the session needs re-pairing, so the notice wins and the green banner
  // is suppressed.
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
  // The pairing handshake is finished — release the relay sockets this connect
  // flow opened. Any later signing (money-auth, handle refresh) opens its own
  // short-lived pool, so nothing here is reused.
  pool.close(relays);
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

    const userPubkey = await withSignerTimeout(
      bunker.getPublicKey(),
      'reading your identity',
      SIGNER_CONNECT_TIMEOUT_MS,
      { cancellable: false }
    );

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
    const signedAuthEvent = await withSignerTimeout(
      bunker.signEvent({
        kind: NOSTR_AUTH_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['challenge', READ_AUTH_CONTENT],
          ['relay', backendUrl],
        ],
        content: READ_AUTH_CONTENT,
      }),
      'signing you in',
      SIGNER_CONNECT_TIMEOUT_MS,
      { cancellable: false }
    );
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
 *
 * @param operation Human label for the calling flow ("payout approval",
 *   "wallet connection", …), surfaced in the slow-signer notice and the
 *   timeout error so the message matches what the user actually did.
 */
export async function signMoneyAuthEvent(
  nonce: string,
  operation: string = 'signing request'
): Promise<VerifiedEvent> {
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
    // Bounded: an unanswered sign request here used to hang the whole call —
    // the money endpoint never got its credential, so no POST was ever made and
    // the user saw nothing at all (no payout, no error).
    return await withSignerTimeout(
      bunker.signEvent({
        kind: NOSTR_AUTH_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['challenge', WRITE_AUTH_CONTENT],
          ['nonce', nonce],
          ['relay', backendUrl],
        ],
        content: WRITE_AUTH_CONTENT,
      }),
      operation,
      SIGNER_WRITE_TIMEOUT_MS
    );
  } finally {
    pool.close(bunkerPointer.relays);
  }
}
