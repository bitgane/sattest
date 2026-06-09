import * as vscode from 'vscode';

let cachedApiKey: string | undefined;

/**
 * Returns the configured backend URL, falling back to http://localhost:3000.
 * Warns if a non-localhost URL uses plain HTTP.
 */
export function getBackendUrl(): string {
  const config = vscode.workspace.getConfiguration('sattest');
  const url = config.get<string>('backendUrl') || 'http://localhost:3000';
  // Strip trailing slash for consistency
  return url.replace(/\/+$/, '');
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
