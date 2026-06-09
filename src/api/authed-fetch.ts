import { getNostrAuthHeaders } from './nostr-auth.js';

/**
 * Shared `fetch` wrapper for backend calls that carry a Nostr auth header.
 *
 * The extension signs one auth event at connect time and reuses it; the backend
 * rejects it (401) once it ages past its freshness window. Rather than dead-end
 * the user, `authedFetch` can transparently trigger a re-auth (reconnect to the
 * signer, which mints a fresh event) and retry the request once.
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
 */
export async function authedFetch(
  url: string | URL,
  init: RequestInit = {},
  opts: { interactiveReauth?: boolean } = {}
): Promise<Response> {
  const run = async (): Promise<Response> => {
    const headers = await getNostrAuthHeaders(
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
    // getNostrAuthHeaders throws when there is no stored auth event at all.
    // Treat that like an expired session when the caller allows reconnecting.
    if (opts.interactiveReauth && (await reauth())) {
      return run();
    }
    throw error;
  }
}
