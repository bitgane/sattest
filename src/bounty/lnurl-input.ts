import * as vscode from 'vscode';
import { getLnurlLimits } from '../api/bounty.api.js';

// Disallows leading/trailing dots, consecutive dots, etc. Same regex the claim
// flow historically used — kept identical so validation is stable across the
// claim & refund entry points.
const LN_ADDRESS_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export interface PromptForLnurlOptions {
  /**
   * When set, the input box also checks (while open) that this many sats fits
   * the destination wallet's LNURL min/max sendable bounds, keeping the box
   * open with a message if it doesn't. Omit to do format-only validation
   * (e.g. the refund prompt).
   */
  amountSats?: number;
}

/**
 * Prompt the user for an LNURL or Lightning address. Accepts either a raw
 * `lnurl...` string or an `alice@domain.tld` LN-address. Returns `undefined`
 * if the user dismisses the prompt.
 *
 * When `opts.amountSats` is provided, the validation also resolves the LNURL's
 * sendable bounds and blocks (keeping the box open) when the amount is below
 * the wallet's minimum or above its maximum receivable amount. The resolution
 * is cached per value so VS Code's per-keystroke validation doesn't spam the
 * backend, and it fails open: if the bounds can't be resolved, the box accepts
 * and the backend claim endpoint remains the authoritative check.
 */
export async function promptForLnurl(
  title: string,
  prompt: string,
  opts: PromptForLnurlOptions = {}
): Promise<string | undefined> {
  const { amountSats } = opts;
  // Cache resolved limits per trimmed value. `undefined` = not yet fetched;
  // `null` = fetched but unresolved (fail open).
  const limitsCache = new Map<string, { minSendable: number; maxSendable: number } | null>();

  const raw = await vscode.window.showInputBox({
    title,
    prompt,
    validateInput: async (v) => {
      const value = v.trim();
      // 1. Format gate (synchronous — no network for malformed/partial input).
      if (!value.startsWith('lnurl') && !LN_ADDRESS_REGEX.test(value)) {
        return 'LNURL is not a valid format. Must start with lnurl... or formatted like guppie@primal.net';
      }
      if (amountSats === undefined) {
        return null;
      }

      // 2. Range check against the destination wallet's sendable bounds.
      let limits = limitsCache.get(value);
      if (limits === undefined) {
        limits = await getLnurlLimits(value);
        limitsCache.set(value, limits);
      }
      if (!limits) {
        return null; // couldn't resolve — fail open; backend is the backstop
      }

      const amountMsat = amountSats * 1000;
      if (amountMsat < limits.minSendable) {
        const minSats = Math.ceil(limits.minSendable / 1000);
        return `This LNURL has a minimum sendable amount of ${minSats} sats, higher than the ${amountSats} sat bounty. Please enter another LNURL.`;
      }
      if (amountMsat > limits.maxSendable) {
        const maxSats = Math.floor(limits.maxSendable / 1000);
        return `This LNURL only accepts up to ${maxSats} sats, less than the ${amountSats} sat bounty. Please enter another LNURL.`;
      }
      return null;
    },
  });
  return raw?.trim() || undefined;
}
