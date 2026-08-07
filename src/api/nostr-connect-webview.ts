import * as vscode from 'vscode';
import { escapeHtml } from '../util/html.js';

/**
 * Replace the Connect to Nostr panel with a minimal "you're connected" view
 * after a successful pairing. Strips the QR / copy-URI / scan instructions so
 * the panel can't be re-used to pair a third identity in the seconds before
 * it auto-closes.
 *
 * Self-contained HTML (no script, no external resources) so it works under
 * the panel's existing CSP without further nonces.
 */
export function renderConnectedSuccess(panel: vscode.WebviewPanel, userHandle: string): void {
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
