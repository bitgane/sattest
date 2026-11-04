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
const NOSTR_BUNKER_POINTER = 'nostr_bunker_pointer';
const DEFAULT_NOSTR_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.nsec.app',
];

const NWC_CONNECTION_URI = 'nwc_connection_uri';
const NWC_META_KEY = 'sattest.nwcMeta';

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

// Bunker pointer (remote signer pubkey, relays, connect secret) — persisted so
// every signed action can reconstruct a signer session without re-scanning
// the connect QR each time.
export async function getNostrBunkerPointer(): Promise<string | undefined> {
  return getContext().secrets.get(NOSTR_BUNKER_POINTER);
}

export async function setNostrBunkerPointer(value: string): Promise<void> {
  await getContext().secrets.store(NOSTR_BUNKER_POINTER, value);
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

/**
 * Relays bounty and claim events are published to and read from.
 *
 * Same rules as `getNostrRelays`: machine-scoped, only the user (global) value
 * or the default is honoured, and only wss:// (or ws://localhost) entries
 * survive. A repository must not be able to steer where bounty state is read
 * from — a hostile relay could withhold events, though it can't forge them.
 */
export const DEFAULT_BOUNTY_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
];

export const getBountyRelays = (): string[] => {
  const inspected = vscode.workspace
    .getConfiguration('sattest')
    .inspect<string[]>('bountyRelays');
  const candidate = inspected?.globalValue ?? inspected?.defaultValue;
  const relays = Array.isArray(candidate) ? candidate.filter(isSafeRelayUrl) : [];
  return relays.length > 0 ? relays : DEFAULT_BOUNTY_RELAYS;
};

/**
 * Bounty creators the user trusts (hex pubkeys or npubs), from user settings
 * only. Used to rank competing bounties on the same test so a stranger's
 * newer bounty can't displace a maintainer's.
 */
export const getTrustedCreators = (): string[] => {
  const inspected = vscode.workspace
    .getConfiguration('sattest')
    .inspect<string[]>('trustedCreators');
  const candidate = inspected?.globalValue ?? inspected?.defaultValue;
  return Array.isArray(candidate)
    ? candidate.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    : [];
};

// Nostr Wallet Connect (NIP-47) connection string. This is a Lightning
// SPENDING credential: it lives only in VS Code's SecretStorage and never
// leaves this machine except as signed, encrypted requests to the wallet's own
// relay.
export async function getNwcUri(): Promise<string | undefined> {
  return getContext().secrets.get(NWC_CONNECTION_URI);
}

export async function setNwcUri(value: string): Promise<void> {
  await getContext().secrets.store(NWC_CONNECTION_URI, value);
}

export async function clearNwcUri(): Promise<void> {
  await getContext().secrets.delete(NWC_CONNECTION_URI);
}

/** Non-secret, display-only facts about the connected wallet. */
export interface NwcMeta {
  relay?: string;
  lud16?: string;
  walletPubkey?: string;
  budgetSats?: number;
  budgetWindow?: 'daily' | 'weekly' | 'monthly';
  connectedAt?: string;
}

export function getNwcMeta(): NwcMeta | undefined {
  return getContext().globalState.get<NwcMeta>(NWC_META_KEY);
}

export async function setNwcMeta(value: NwcMeta | undefined): Promise<void> {
  await getContext().globalState.update(NWC_META_KEY, value);
}

/** The extension's globalState — the payout journal and relay outbox live here. */
export function getGlobalState(): vscode.Memento {
  return getContext().globalState;
}
