import * as vscode from 'vscode';
import { escapeHtml } from '../util/html.js';

/**
 * Every HTML document the Connect-to-Nostr flow paints.
 *
 * These lived as four template literals inside `nostr.api.ts`, which put ~230
 * lines of markup and three near-identical copies of the same stylesheet in the
 * middle of the module that does NIP-46 signing. Editing a colour meant editing
 * it in three places and hoping; the flow's actual logic was hard to read past
 * the CSS. The markup is presentation and belongs here.
 *
 * Every view is self-contained (no external resources) so it satisfies the
 * panel's `default-src 'none'` CSP. Only the QR view runs script, and only under
 * an explicit nonce.
 */

/**
 * The one stylesheet all connect views share.
 *
 * `.connected` (green, an identity is active) and `.notice-action` (yellow,
 * something needs the user's attention) are mutually exclusive by design — see
 * `connectBanners`.
 */
const CONNECT_STYLES = `
      body {
        font-family: monospace;
        padding: 20px;
        background: #f5f5f5;
        color: #333;
        margin: 0;
      }
      h2 { text-align: center; color: #2c3e50; }
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
      button:hover { background: #2980b9; }
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
      .error {
        background: #fdecea;
        border: 1px solid #f5c6cb;
        color: #721c24;
        padding: 12px;
        border-radius: 4px;
        line-height: 1.5;
      }
      .status { text-align: center; font-weight: bold; margin-top: 20px; }
      .closing { text-align: center; color: #555; margin-top: 24px; }
`;

/**
 * Rules only the QR view needs, kept out of the shared block.
 *
 * Not merely tidiness: a page that ships `.qr-container` CSS while showing no QR
 * makes "is the QR gone?" unanswerable by inspecting the document, which is
 * exactly how the connect flow is asserted. A view carries the styles it uses.
 */
const QR_STYLES = `
      .qr-container { text-align: center; margin: 20px 0; }
      .qr-container svg { max-width: 250px; height: auto; }
`;

/**
 * Wrap page content in the shared shell.
 *
 * `scriptNonce` widens the CSP to allow exactly one inline script; omit it and
 * the page can't execute anything at all, which is what every view but the QR
 * one wants.
 */
function page(
  title: string,
  body: string,
  scriptNonce?: string,
  extraStyles = ''
): string {
  const csp = scriptNonce
    ? `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}';`
    : `default-src 'none'; style-src 'unsafe-inline';`;
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="${csp}">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${escapeHtml(title)}</title>
      <style>${CONNECT_STYLES}${extraStyles}</style>
    </head>
    <body>
      <h2>Connect to Nostr</h2>
${body}
    </body>
    </html>
  `;
}

export interface ConnectBanners {
  /** Yellow call-to-action, e.g. an expired-session notice. */
  noticeBannerHtml: string;
  /** Green "Connected as …" banner. */
  connectedBannerHtml: string;
}

/**
 * Build the two banner fragments for the connect flow.
 *
 * They are mutually exclusive: when a notice is present the flow's whole point
 * is that the session needs re-pairing, so showing "Connected as @alice" beside
 * "Refresh your Nostr connection" would contradict itself at a glance. The
 * notice wins and the green banner is suppressed.
 */
export function connectBanners(
  noticeText: string | undefined,
  identityDisplay: string | undefined
): ConnectBanners {
  return {
    noticeBannerHtml: noticeText
      ? `<div class="notice-action">${escapeHtml(noticeText)}</div>`
      : '',
    connectedBannerHtml:
      identityDisplay && !noticeText
        ? `<div class="connected">Connected as ${escapeHtml(identityDisplay)}</div>`
        : '',
  };
}

/** First paint — shown immediately so the panel is never blank while relays dial. */
export function renderConnecting(): string {
  return page('Connect to Nostr', `      <p style="text-align:center;">Connecting to Nostr relays…</p>`);
}

/** Terminal state: not one configured relay answered. */
export function renderRelayFailure(relays: string[]): string {
  return page(
    'Connect to Nostr',
    `      <div class="error">Could not reach any configured Nostr relay:<br>${relays
      .map(escapeHtml)
      .join('<br>')}<br><br>Check your network, or adjust the <b>sattest.nostrRelays</b> setting.</div>`
  );
}

/**
 * Placeholder painted while the signer-response subscription goes live.
 *
 * The QR is deliberately withheld until the listener is warm: NIP-46 responses
 * are ephemeral, so a scan that beats the subscription is dropped — which is the
 * "have to connect twice" bug.
 */
export function renderConnectPlaceholder(banners: ConnectBanners): string {
  return page(
    'Connect to Nostr',
    `      ${banners.noticeBannerHtml}
      ${banners.connectedBannerHtml}
      <p class="status">Establishing secure connection…</p>`
  );
}

/**
 * The scannable QR view.
 *
 * Keeps `<p id="status" class="status">` — `resolveNostrInfoFromBunkerSigner`
 * rewrites that element by regex to report progress, so the id must survive.
 */
export function renderConnectQr(opts: {
  connectionUri: string;
  qrSvg: string;
  nonce: string;
  banners: ConnectBanners;
}): string {
  const { connectionUri, qrSvg, nonce, banners } = opts;
  return page(
    'Connect to Nostr',
    `      ${banners.noticeBannerHtml}
      ${banners.connectedBannerHtml}
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
      </script>`,
    nonce,
    QR_STYLES
  );
}

/**
 * Replace the Connect to Nostr panel with a minimal "you're connected" view
 * after a successful pairing. Strips the QR / copy-URI / scan instructions so
 * the panel can't be re-used to pair a third identity in the seconds before
 * it auto-closes.
 */
export function renderConnectedSuccess(panel: vscode.WebviewPanel, userHandle: string): void {
  panel.webview.html = page(
    'Connected to Nostr',
    `      <div class="connected">Connected as ${escapeHtml(userHandle)}</div>
      <p class="closing">Closing in a few seconds…</p>`
  );
}
