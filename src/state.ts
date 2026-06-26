import * as vscode from 'vscode';

// Internal reference – will be set in activate()
let extensionContextRef: vscode.ExtensionContext | undefined;

// Called once in activate()
export function initializeSecrets(context: vscode.ExtensionContext) {
  extensionContextRef = context;
}

// Helper to get context safely
function getContext(): vscode.ExtensionContext {
  if (!extensionContextRef) {
    throw new Error('Extension context not initialized – call initializeSecrets first');
  }
  return extensionContextRef;
}
const NOSTR_CLIENT_SECRET_KEY = 'nostr_client_secret_hex';
const NOSTR_USER_PUBKEY = 'nostr_user_pubkey';
const NOSTR_USER_HANDLE = 'nostr_user_handle';
const NOSTR_AUTH_EVENT = 'nostr_auth_event';
const DEFAULT_NOSTR_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.nsec.app',
];

const LNBITS_URL = 'lnbits_url';
const LNBITS_API_KEY = 'lnbits_api_key';
const LNBITS_IS_DEFAULT = 'lnbits_is_default';

// Nostr client secret (hex string)
export async function getNostrClientSecret(): Promise<string | undefined> {
  return getContext().secrets.get(NOSTR_CLIENT_SECRET_KEY);
}

export async function setNostrClientSecret(value: string): Promise<void> {
  await getContext().secrets.store(NOSTR_CLIENT_SECRET_KEY, value);
}

// Nostr user pubkey
export async function getNostrUserPubkey(): Promise<string | undefined> {
  return getContext().secrets.get(NOSTR_USER_PUBKEY);
}

export async function setNostrUserPubkey(value: string): Promise<void> {
  await getContext().secrets.store(NOSTR_USER_PUBKEY, value);
}

// Nostr user handle
export async function getNostrUserHandle(): Promise<string | undefined> {
  return getContext().secrets.get(NOSTR_USER_HANDLE);
}

export async function setNostrUserHandle(value: string): Promise<void> {
  await getContext().secrets.store(NOSTR_USER_HANDLE, value);
}

// Nostr auth event (signed event for backend authentication)
export async function getNostrAuthEvent(): Promise<string | undefined> {
  return getContext().secrets.get(NOSTR_AUTH_EVENT);
}

export async function setNostrAuthEvent(value: string): Promise<void> {
  await getContext().secrets.store(NOSTR_AUTH_EVENT, value);
}

/** True for a relay URL we'll connect to: wss anywhere, ws only on localhost. */
function isSafeRelayUrl(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol === 'wss:') {
    return true;
  }
  if (parsed.protocol === 'ws:') {
    const host = parsed.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  }
  return false;
}

// Nostr relays.
//
// Security: `nostrRelays` is declared `machine`-scoped in package.json, and we
// defensively read only the user (global) value or the built-in default via
// `inspect()` — never a workspace/folder-provided list. This stops a malicious
// repo's `.vscode/settings.json` from pointing NIP-46 signer traffic at
// attacker-controlled relays. Each entry must be wss:// (or ws://localhost for
// local development); invalid entries are dropped, and an empty result falls
// back to the defaults.
export const getNostrRelays = (): string[] => {
  const config = vscode.workspace.getConfiguration('sattest');
  const inspected = config.inspect<string[]>('nostrRelays');
  const candidate = inspected?.globalValue ?? inspected?.defaultValue;
  const relays = Array.isArray(candidate) ? candidate.filter(isSafeRelayUrl) : [];
  if (relays.length > 0) {
    return relays;
  }
  return DEFAULT_NOSTR_RELAYS;
};

// Lbnits URL
export async function getLnbitsUrl(): Promise<string | undefined> {
  return getContext().secrets.get(LNBITS_URL);
}

export async function setLnbitsUrl(value: string): Promise<void> {
  await getContext().secrets.store(LNBITS_URL, value);
}

// Lbnits API key
export async function getLnbitsApiKey(): Promise<string | undefined> {
  return getContext().secrets.get(LNBITS_API_KEY);
}

export async function setLnbitsApiKey(value: string): Promise<void> {
  await getContext().secrets.store(LNBITS_API_KEY, value);
}

// Use default LNbits config
export async function getIsDefaultLnbits(): Promise<boolean> {
  const isDefaultLnbits = await getContext().secrets.get(LNBITS_IS_DEFAULT);
  if (isDefaultLnbits === null || isDefaultLnbits === undefined) {
    return false;
  }
  const trimmed = isDefaultLnbits.trim().toLowerCase();

  // Explicit true values
  return (
    trimmed === 'true' ||
    trimmed === '1' ||
    trimmed === 'yes' ||
    trimmed === 'y' ||
    trimmed === 'on'
  );
}

export async function setIsDefaultLnbits(value: string): Promise<void> {
  await getContext().secrets.store(LNBITS_IS_DEFAULT, value);
}
