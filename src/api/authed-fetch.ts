import { getNostrAuthHeaders, getNostrMoneyAuthHeaders } from './nostr-auth.js';

/**
 * Shared `fetch` wrapper for backend calls that carry a Nostr auth header.
 *
 * The extension signs two auth events at connect time (read + write scope) and
 * reuses them; the backend rejects them (401) once they age past their freshness
 * window. Rather than dead-end the user, `authedFetch` can transparently trigger
 * a re-auth (reconnect to the signer, which mints fresh events) and retry once.
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
 */
export async function authedFetch(
  url: string | URL,
  init: RequestInit = {},
  opts: { interactiveReauth?: boolean; scope?: 'read' | 'write' } = {}
): Promise<Response> {
  const getHeaders = opts.scope === 'write' ? getNostrMoneyAuthHeaders : getNostrAuthHeaders;

  const run = async (): Promise<Response> => {
    const headers = await getHeaders(
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
    // getNostrAuthHeaders / getNostrMoneyAuthHeaders throw when there is no
    // stored auth event at all. Treat that like an expired session when the
    // caller allows reconnecting.
    if (opts.interactiveReauth && (await reauth())) {
      return run();
    }
    throw error;
  }
}
