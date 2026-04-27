import * as vscode from 'vscode';
import { getBackendUrl } from './config.js';
import { getNostrAuthHeaders } from './nostr-auth.js';

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
  budgetSats?: number | null;
  budgetWindow?: 'daily' | 'weekly' | 'monthly' | null;
  updatedAt?: string | null;
}

/**
 * Connect or update the caller's NWC grant.
 *
 * Returns `true` on success, `false` on failure (and surfaces a toast). Kept
 * boolean — callers don't need the response body since it's just
 * `{ configured: true }` with nothing new to show.
 */
export async function setNwcUri(
  uri: string,
  budgetSats?: number,
  budgetWindow?: 'daily' | 'weekly' | 'monthly',
): Promise<boolean> {
  try {
    const response = await fetch(`${getBackendUrl()}/users/me/nwc`, {
      method: 'PATCH',
      headers: await getNostrAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        uri: uri.trim(),
        ...(budgetSats !== undefined ? { budgetSats } : {}),
        ...(budgetWindow !== undefined ? { budgetWindow } : {}),
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(errText || `Backend error: ${response.status}`);
    }

    return true;
  } catch (error) {
    console.error('[setNwcUri] Error:', error);
    vscode.window.showErrorMessage(
      `Failed to connect wallet: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
    return false;
  }
}

/** Disconnect the caller's wallet. Silent success — surfaces a toast on failure. */
export async function clearNwcUri(): Promise<boolean> {
  try {
    const response = await fetch(`${getBackendUrl()}/users/me/nwc`, {
      method: 'DELETE',
      headers: await getNostrAuthHeaders({ 'Content-Type': 'application/json' }),
    });

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
    const response = await fetch(`${getBackendUrl()}/users/me/nwc-status`, {
      method: 'GET',
      headers: await getNostrAuthHeaders({ 'Content-Type': 'application/json' }),
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
