import * as vscode from 'vscode';
import { SignerCancelledError } from './signer-errors.js';

/**
 * Shared handling for a failed backend call.
 *
 * Every function in `bounty.api.ts` ended with the same catch: swallow a user
 * cancellation, log, toast, return a falsy sentinel. Seven copies, each free to
 * drift in how it worded the toast or whether it remembered the cancel case —
 * and missing the cancel case is user-visible, since it pops an error toast at
 * someone who deliberately dismissed their signer.
 */

/**
 * Pull the most informative message out of a non-OK backend response.
 *
 * The backend puts real detail in different places depending on the failure:
 * `message` carries dev-mode exception text and the NWC/LNbits reason, `error`
 * carries the user-facing summary, and Zod failures add a structured `issues`
 * array. Preferring whichever is actually informative is what turns "Approval
 * failed: 502" into the reason it failed.
 */
export async function describeErrorResponse(
  response: Response,
  fallback: string
): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: string;
      message?: string;
      issues?: Array<{ field: string; message: string }>;
    };

    const issues = body.issues?.map((i) => `${i.field}: ${i.message}`).join('; ');
    if (issues) {
      return `${body.error ?? 'Validation failed'} — ${issues}`;
    }
    // 'Internal server error' is the production placeholder — it says nothing,
    // so prefer the `error` summary over it.
    if (body.message && body.message !== 'Internal server error') {
      return body.error ? `${body.error}: ${body.message}` : body.message;
    }
    return body.error || fallback;
  } catch {
    // Body wasn't JSON. Deliberately no `text()` retry here: `json()` has
    // already consumed the response body, so a second read yields nothing on a
    // real Response — the status line in `fallback` is what's left to report.
    return fallback;
  }
}

/**
 * True when the error is the user dismissing their signer prompt.
 *
 * A deliberate abort, not a failure: callers return their empty value and show
 * nothing at all.
 */
export function isUserCancellation(error: unknown): boolean {
  return error instanceof SignerCancelledError;
}

/**
 * Log and toast a failed API call, unless the user cancelled it.
 *
 * @returns `true` when the caller should stay silent (user cancelled), so a call
 *   site reads `if (handleApiError(...)) return null;`.
 */
export function handleApiError(
  error: unknown,
  opts: { scope: string; userMessage: string }
): boolean {
  if (isUserCancellation(error)) {
    return true;
  }
  console.error(`[${opts.scope}] ${opts.userMessage}:`, error);
  vscode.window.showErrorMessage(
    `${opts.userMessage}: ${error instanceof Error ? error.message : 'Unknown error'}`
  );
  return false;
}
