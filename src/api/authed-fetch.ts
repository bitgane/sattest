import { getNostrAuthHeaders, getNostrMoneyAuthHeaders } from './nostr-auth.js';
import {
  SignerCancelledError,
  SignerTimeoutError,
  SignerUnresponsiveError,
} from './signer-errors.js';

/**
 * Shared `fetch` wrapper for backend calls that carry a Nostr auth header.
 *
 * The extension signs a read-scope auth event at connect time and reuses it;
 * the backend rejects it (401) once it ages past its freshness window. Write
 * (money-moving) calls are never cached — each one fetches a fresh
 * server-issued nonce and signs a brand-new write-scope credential bound to
 * it (F4 hardening; see `nostr-auth.ts`), so a signer round-trip happens on
 * every money call. Either way, `authedFetch` can transparently trigger a
 * re-auth (reconnect to the signer) and retry once when the backend responds
 * 401 — e.g. because the read credential expired or no identity is connected
 * yet.
 *
 * Re-auth requires VS Code context (it opens the Connect-to-Nostr panel), so the
 * extension registers a refresher via `setAuthRefresher` at activation rather
 * than this module importing the command layer (avoids a cycle).
 */

type AuthRefresher = () => Promise<boolean>;

let refresher: AuthRefresher | undefined;
// Dedupe: N concurrent 401s share a single in-flight reconnect instead of
// stacking up N Connect-to-Nostr panels.
let inFlightReauth: Promise<boolean> | undefined;

/** Register the interactive re-auth routine (called once from extension activate). */
export function setAuthRefresher(fn: AuthRefresher | undefined): void {
  refresher = fn;
}

async function reauth(): Promise<boolean> {
  if (!refresher) {
    return false;
  }
  if (!inFlightReauth) {
    inFlightReauth = Promise.resolve(refresher()).finally(() => {
      inFlightReauth = undefined;
    });
  }
  return inFlightReauth;
}

/**
 * Fetch with the Nostr auth header attached.
 *
 * @param opts.interactiveReauth When true, a 401 (or a missing stored auth
 *   event) triggers an interactive reconnect and one retry. Use for
 *   user-initiated writes. Leave false for background/fail-soft/per-keystroke
 *   calls so they never pop a webview unexpectedly.
 * @param opts.scope 'write' uses the write-scoped credential required by
 *   `moneyAuth` endpoints. Defaults to 'read' (standard credential).
 * @param opts.operation Human label for the calling flow ("payout approval",
 *   "wallet connection", …), surfaced by the signer notice/timeout so the
 *   message matches what the user actually did. Write scope only.
 */
export async function authedFetch(
  url: string | URL,
  init: RequestInit = {},
  opts: { interactiveReauth?: boolean; scope?: 'read' | 'write'; operation?: string } = {}
): Promise<Response> {
  const run = async (): Promise<Response> => {
    const headers =
      opts.scope === 'write'
        ? await getNostrMoneyAuthHeaders(
            (init.headers as Record<string, string> | undefined) ?? undefined,
            opts.operation
          )
        : await getNostrAuthHeaders(
            (init.headers as Record<string, string> | undefined) ?? undefined
          );
    return fetch(url, { ...init, headers });
  };

  try {
    const response = await run();
    if (response.status === 401 && opts.interactiveReauth && (await reauth())) {
      return run();
    }
    return response;
  } catch (error) {
    // The user chose to cancel the signer wait — a clean, intentional abort.
    // Never reauth, never retry; the caller swallows this silently.
    if (error instanceof SignerCancelledError) {
      throw error;
    }

    // A signer timeout is usually a *stale* session: the pointer we're signing
    // against was ended in the signer app, so it will never answer. Re-pairing
    // mints a fresh pointer + auth event, which is the actual fix — so offer
    // the QR and retry once. If the retry ALSO times out, re-pairing didn't
    // help (signer likely asking per-signature); stop looping and diagnose.
    if (error instanceof SignerTimeoutError) {
      if (opts.interactiveReauth && (await reauth())) {
        try {
          return await run();
        } catch (retryError) {
          if (retryError instanceof SignerTimeoutError) {
            throw new SignerUnresponsiveError(opts.operation ?? 'request');
          }
          throw retryError;
        }
      }
      throw error;
    }

    // getNostrAuthHeaders / getNostrMoneyAuthHeaders throw when there is no
    // stored auth event at all. Treat that like an expired session when the
    // caller allows reconnecting.
    if (opts.interactiveReauth && (await reauth())) {
      return run();
    }
    throw error;
  }
}
