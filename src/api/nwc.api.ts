import * as vscode from 'vscode';
import {
  clearNwcUri as clearStoredNwcUri,
  getNwcMeta,
  getNwcUri,
  setNwcMeta,
  setNwcUri as storeNwcUri,
} from '../state.js';
import { NwcClient, parseNwcUri, summarizeNwcUri } from '../lightning/nwc-client.js';

/**
 * The creator's Lightning wallet connection (NIP-47 Nostr Wallet Connect).
 *
 * The connection string is a budgeted SPENDING credential. It is kept only in
 * VS Code's SecretStorage on this machine — there is no server to send it to —
 * and is used by the extension itself to pay approved claims.
 */

export interface NwcStatus {
  configured: boolean;
  // Public, display-only wallet identity (never the secret).
  relay?: string | null;
  lud16?: string | null;
  budgetSats?: number | null;
  budgetWindow?: 'daily' | 'weekly' | 'monthly' | null;
  updatedAt?: string | null;
}

/**
 * `'ok'` — saved; `'failed'` — invalid or unreachable (a message was shown).
 * `'auth-expired'` is kept in the type for the command's re-auth branch, but a
 * local save never needs a Nostr session, so it is never returned now.
 */
export type SetNwcResult = 'ok' | 'auth-expired' | 'failed';

/** Methods a wallet connection must allow for Sattest payouts to work safely. */
const REQUIRED_METHODS = ['pay_invoice', 'lookup_invoice'];

/**
 * Validate a connection string, check the wallet answers and allows the
 * methods payouts need, then store it locally.
 */
export async function setNwcUri(
  uri: string,
  budgetSats?: number,
  budgetWindow?: 'daily' | 'weekly' | 'monthly',
  opts: { client?: (uri: string) => Pick<NwcClient, 'getInfo' | 'close' | 'walletPubkey'> } = {}
): Promise<SetNwcResult> {
  const trimmed = uri.trim();
  let walletPubkey: string;
  try {
    walletPubkey = parseNwcUri(trimmed).walletPubkey;
  } catch (err) {
    vscode.window.showErrorMessage(
      `Failed to connect wallet: ${err instanceof Error ? err.message : 'invalid connection string'}`
    );
    return 'failed';
  }

  const client = (opts.client ?? ((u: string) => new NwcClient(u)))(trimmed);
  try {
    const info = await client.getInfo();
    // An empty list means the wallet published no info event; NIP-47 allows
    // that, so only refuse when the wallet says it lacks a method we need.
    const missing =
      info.methods.length > 0 ? REQUIRED_METHODS.filter((m) => !info.methods.includes(m)) : [];
    if (missing.length > 0) {
      vscode.window.showErrorMessage(
        `This wallet connection doesn't allow ${missing.join(' and ')}. Create a connection ` +
          'that permits paying and looking up invoices, so Sattest can confirm every payout.'
      );
      return 'failed';
    }
  } catch (err) {
    console.warn('[setNwcUri] wallet info lookup failed, saving anyway:', err);
  } finally {
    client.close();
  }

  await storeNwcUri(trimmed);
  const summary = summarizeNwcUri(trimmed);
  await setNwcMeta({
    relay: summary.relay,
    lud16: summary.lud16,
    walletPubkey,
    budgetSats,
    budgetWindow,
    connectedAt: new Date().toISOString(),
  });
  return 'ok';
}

/** Forget the wallet connection on this machine. */
export async function clearNwcUri(): Promise<boolean> {
  try {
    await clearStoredNwcUri();
    await setNwcMeta(undefined);
    return true;
  } catch (error) {
    console.error('[clearNwcUri] Error:', error);
    vscode.window.showErrorMessage(
      `Failed to disconnect wallet: ${error instanceof Error ? error.message : 'Unknown error'}. ` +
        'You can also revoke this connection directly in your wallet app (Alby Hub, Coinos, …).'
    );
    return false;
  }
}

/** Whether a wallet is connected, with display-only details. */
export async function getNwcStatus(): Promise<NwcStatus> {
  try {
    const uri = await getNwcUri();
    if (!uri) {
      return { configured: false };
    }
    const meta = getNwcMeta() ?? {};
    const summary = summarizeNwcUri(uri);
    return {
      configured: true,
      relay: meta.relay ?? summary.relay ?? null,
      lud16: meta.lud16 ?? summary.lud16 ?? null,
      budgetSats: meta.budgetSats ?? null,
      budgetWindow: meta.budgetWindow ?? null,
      updatedAt: meta.connectedAt ?? null,
    };
  } catch (error) {
    console.error('[getNwcStatus] Error:', error);
    return { configured: false };
  }
}
