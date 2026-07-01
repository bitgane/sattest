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

const CONFIRMED_NWC_BACKENDS_KEY = 'sattest.confirmedNwcBackends';

function originsMatch(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Consent gate before the NWC spending grant is transmitted.
 *
 * `sattest.backendUrl` is machine-scoped, so a repo can't redirect it (H1) — but
 * the user themselves can point it at any https host, and the NWC URI is a
 * Lightning *spending* credential. This guards the social-engineering case
 * ("set your backendUrl to https://faster-sattest.example"): if the configured
 * backend is neither localhost nor the shipped default, we name the host and
 * require explicit consent before the secret leaves, remembering the choice
 * per-origin so normal use isn't nagged.
 *
 * Returns true if it's safe to proceed with sending the URI.
 */
export async function confirmBackendForNwc(
  context: vscode.ExtensionContext
): Promise<boolean> {
  let backendUrl: string;
  try {
    backendUrl = getBackendUrl();
  } catch {
    // getBackendUrl throws on an unsafe/misconfigured URL — send nothing.
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(backendUrl);
  } catch {
    return false;
  }

  // Local development on the user's own machine — never prompt.
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname)) {
    return true;
  }

  // The backend the extension ships with is implicitly trusted.
  const defaultUrl = vscode.workspace
    .getConfiguration('sattest')
    .inspect<string>('backendUrl')?.defaultValue;
  if (defaultUrl && originsMatch(backendUrl, defaultUrl)) {
    return true;
  }

  // Already confirmed this exact origin before.
  const confirmed = context.globalState.get<string[]>(CONFIRMED_NWC_BACKENDS_KEY) ?? [];
  if (confirmed.includes(parsed.origin)) {
    return true;
  }

  const choice = await vscode.window.showWarningMessage(
    `You're about to send your Lightning wallet grant (NWC) to "${parsed.host}", which is not the ` +
      'default Sattest backend. That server would gain spending access to your wallet up to its ' +
      'budget. Only continue if you trust it.',
    { modal: true },
    'Send to this server'
  );
  if (choice !== 'Send to this server') {
    return false;
  }

  await context.globalState.update(CONFIRMED_NWC_BACKENDS_KEY, [...confirmed, parsed.origin]);
  return true;
}

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
