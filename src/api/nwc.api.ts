import * as vscode from 'vscode';
import { getBackendUrl } from './config.js';
import { authedFetch } from './authed-fetch.js';

/**
 * Client for the backend's `/users/me/nwc*` endpoints. All of these manage the
 * caller's NIP-47 Nostr Wallet Connect grant — a budgeted `pay_invoice`
 * permission the creator issues once and reuses for every non-custodial
 * bounty they create.
 *
 * The URI itself is a secret. It leaves the extension exactly once (POSTed
 * to PATCH /users/me/nwc) and is never returned by the backend thereafter.
 */

export interface NwcStatus {
  configured: boolean;
  // Public, display-only wallet identity parsed server-side from the stored
  // URI (never the secret). Used to show *which* wallet a bounty will draw
  // from at creation time. Null when not configured or the URI didn't parse.
  relay?: string | null;
  lud16?: string | null;
  budgetSats?: number | null;
  budgetWindow?: 'daily' | 'weekly' | 'monthly' | null;
  updatedAt?: string | null;
}

/**
 * Outcome of `setNwcUri`:
 *   - `'ok'`           — grant saved.
 *   - `'auth-expired'` — the stored Nostr auth event was rejected (401). The
 *                        caller should refresh the Nostr session and retry; we
 *                        deliberately stay silent (no toast) so the command can
 *                        own that re-auth UX.
 *   - `'failed'`       — any other failure (a toast was already shown).
 */
export type SetNwcResult = 'ok' | 'auth-expired' | 'failed';

/**
 * Connect or update the caller's NWC grant.
 *
 * Returns a `SetNwcResult` so the caller can distinguish an expired-auth 401
 * (recoverable by re-connecting Nostr) from a genuine failure.
 */
export async function setNwcUri(
  uri: string,
  budgetSats?: number,
  budgetWindow?: 'daily' | 'weekly' | 'monthly',
): Promise<SetNwcResult> {
  try {
    // interactiveReauth is intentionally OFF here — the connectWallet command
    // owns a bespoke re-auth flow (wallet-specific message + URI retry), so we
    // surface the 401 as 'auth-expired' rather than letting authedFetch reconnect.
    const response = await authedFetch(`${getBackendUrl()}/users/me/nwc`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uri: uri.trim(),
        ...(budgetSats !== undefined ? { budgetSats } : {}),
        ...(budgetWindow !== undefined ? { budgetWindow } : {}),
      }),
    });

    // 401 = the stored Nostr auth event has aged out (backend's freshness
    // window). Recoverable: the caller refreshes the session and retries with
    // the same URI. Return silently — no error toast.
    if (response.status === 401) {
      return 'auth-expired';
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(errText || `Backend error: ${response.status}`);
    }

    return 'ok';
  } catch (error) {
    console.error('[setNwcUri] Error:', error);
    vscode.window.showErrorMessage(
      `Failed to connect wallet: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
    return 'failed';
  }
}

/** Disconnect the caller's wallet. Silent success — surfaces a toast on failure. */
export async function clearNwcUri(): Promise<boolean> {
  try {
    const response = await authedFetch(`${getBackendUrl()}/users/me/nwc`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    }, { interactiveReauth: true });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(errText || `Backend error: ${response.status}`);
    }

    return true;
  } catch (error) {
    console.error('[clearNwcUri] Error:', error);
    vscode.window.showErrorMessage(
      `Failed to disconnect wallet: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
    return false;
  }
}

/**
 * UI helper. Returns `{ configured: false }` when the user has no wallet
 * connected (or the request fails — we don't want a transient backend error
 * to block the user from creating a custodial bounty).
 */
export async function getNwcStatus(): Promise<NwcStatus> {
  try {
    const response = await authedFetch(`${getBackendUrl()}/users/me/nwc-status`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Backend error: ${response.status}`);
    }

    return (await response.json()) as NwcStatus;
  } catch (error) {
    console.error('[getNwcStatus] Error:', error);
    return { configured: false };
  }
}
