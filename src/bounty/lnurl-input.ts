import * as vscode from 'vscode';

// Disallows leading/trailing dots, consecutive dots, etc. Same regex the claim
// flow historically used — kept identical so validation is stable across the
// claim & refund entry points.
const LN_ADDRESS_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/**
 * Prompt the user for an LNURL or Lightning address. Accepts either a raw
 * `lnurl...` string or an `alice@domain.tld` LN-address. Returns `undefined`
 * if the user dismisses the prompt.
 */
export async function promptForLnurl(
  title: string,
  prompt: string
): Promise<string | undefined> {
  const raw = await vscode.window.showInputBox({
    title,
    prompt,
    validateInput: (v) => {
      v = v.trim();
      if (!v.startsWith('lnurl') && !LN_ADDRESS_REGEX.test(v)) {
        return 'LNURL is not a valid format. Must start with lnurl... or formatted like guppie@primal.net';
      }
      return null;
    },
  });
  return raw?.trim() || undefined;
}
