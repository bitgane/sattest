import * as vscode from 'vscode';

let cachedApiKey: string | undefined;

/**
 * True if `url` is safe to use as the backend: https anywhere, or http only for
 * a loopback host (local development). Everything else is refused — the backend
 * receives the Nostr auth credential and the NWC spending grant, so it must not
 * be a plaintext or attacker-reachable endpoint.
 */
function isSafeBackendUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') {
    return true;
  }
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  }
  return false;
}

/**
 * Returns the configured backend base URL.
 *
 * Security: `backendUrl` is declared `machine`-scoped in package.json, but we
 * also defensively ignore any workspace/folder-provided value here via
 * `inspect()` — only the user (global) value or the built-in default is
 * honored. This prevents a malicious repo's `.vscode/settings.json` from
 * redirecting the Nostr auth credential and NWC spending grant to an
 * attacker-controlled server. The resolved URL must be https (or http on
 * localhost); anything else throws so callers fail closed rather than leak.
 */
export function getBackendUrl(): string {
  const config = vscode.workspace.getConfiguration('sattest');
  const inspected = config.inspect<string>('backendUrl');
  const raw =
    inspected?.globalValue ??
    inspected?.defaultValue ??
    'http://localhost:3000';
  const url = raw.replace(/\/+$/, '');

  if (!isSafeBackendUrl(url)) {
    throw new Error(
      `Refusing to use sattest.backendUrl "${url}": only https:// (or http://localhost) is allowed. ` +
        'Set it in your User settings.'
    );
  }
  return url;
}

/**
 * Retrieves the API key from (in order):
 * 1. In-memory cache
 * 2. VS Code setting `sattest.apiKey`
 * 3. Interactive prompt (saved back to settings)
 *
 * Throws if the user cancels the prompt without providing a key.
 */
export async function getApiKey(): Promise<string> {
  if (cachedApiKey) {
    return cachedApiKey;
  }

  const config = vscode.workspace.getConfiguration('sattest');
  const settingsKey = config.get<string>('apiKey');

  if (settingsKey) {
    cachedApiKey = settingsKey;
    return cachedApiKey;
  }

  const inputKey = await vscode.window.showInputBox({
    prompt: 'Enter your Sattest API key',
    placeHolder: 'your-api-key',
    ignoreFocusOut: true,
    password: true,
  });

  if (!inputKey) {
    throw new Error(
      'API key is required. Set it in Settings > sattest.apiKey or provide it when prompted.'
    );
  }

  await config.update('apiKey', inputKey, vscode.ConfigurationTarget.Global);
  cachedApiKey = inputKey;
  return cachedApiKey;
}

/**
 * Returns a headers object containing the X-API-Key header.
 * Optionally merges with additional headers.
 */
export async function getApiHeaders(
  extra?: Record<string, string>
): Promise<Record<string, string>> {
  const apiKey = await getApiKey();
  return {
    'X-API-Key': apiKey,
    ...extra,
  };
}
