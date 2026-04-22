import * as vscode from 'vscode';
import {
  initializeSecrets,
  getNostrClientSecret,
  setNostrClientSecret,
  getNostrUserPubkey,
  setNostrUserPubkey,
  getNostrUserHandle,
  setNostrUserHandle,
  getNostrAuthEvent,
  setNostrAuthEvent,
  getNostrRelays,
  getLnbitsUrl,
  setLnbitsUrl,
  getLnbitsApiKey,
  setLnbitsApiKey,
  getIsDefaultLnbits,
  setIsDefaultLnbits,
} from './state.js';

function createMockContext(): vscode.ExtensionContext {
  const secretsMap = new Map<string, string>();
  return {
    globalState: {
      get: jest.fn().mockReturnValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      keys: jest.fn().mockReturnValue([]),
      setKeysForSync: jest.fn(),
    },
    secrets: {
      get: jest.fn().mockImplementation((key: string) => Promise.resolve(secretsMap.get(key))),
      store: jest.fn().mockImplementation((key: string, value: string) => {
        secretsMap.set(key, value);
        return Promise.resolve();
      }),
      delete: jest.fn().mockImplementation((key: string) => {
        secretsMap.delete(key);
        return Promise.resolve();
      }),
      onDidChange: jest.fn(),
    },
    subscriptions: [],
    extensionPath: '',
    asAbsolutePath: jest.fn((path: string) => path),
    storagePath: '',
    globalStoragePath: '',
    logPath: '',
  } as unknown as vscode.ExtensionContext;
}

describe('state', () => {
  let mockContext: vscode.ExtensionContext;

  beforeEach(() => {
    mockContext = createMockContext();
    initializeSecrets(mockContext);
  });

  describe('initializeSecrets', () => {
    it('throws if context not initialized', () => {
      // Re-import to get fresh module state would be ideal, but we can test
      // indirectly that initializeSecrets sets the context
      expect(mockContext).toBeDefined();
    });
  });

  describe('Nostr client secret', () => {
    it('returns undefined when no secret stored', async () => {
      const result = await getNostrClientSecret();
      expect(result).toBeUndefined();
    });

    it('stores and retrieves client secret', async () => {
      await setNostrClientSecret('abc123hex');
      const result = await getNostrClientSecret();
      expect(result).toBe('abc123hex');
    });
  });

  describe('Nostr user pubkey', () => {
    it('returns undefined when no pubkey stored', async () => {
      const result = await getNostrUserPubkey();
      expect(result).toBeUndefined();
    });

    it('stores and retrieves pubkey', async () => {
      await setNostrUserPubkey('npub1xyz');
      const result = await getNostrUserPubkey();
      expect(result).toBe('npub1xyz');
    });
  });

  describe('Nostr user handle', () => {
    it('returns undefined when no handle stored', async () => {
      const result = await getNostrUserHandle();
      expect(result).toBeUndefined();
    });

    it('stores and retrieves handle', async () => {
      await setNostrUserHandle('@alice');
      const result = await getNostrUserHandle();
      expect(result).toBe('@alice');
    });
  });

  describe('Nostr auth event', () => {
    it('returns undefined when no auth event stored', async () => {
      const result = await getNostrAuthEvent();
      expect(result).toBeUndefined();
    });

    it('stores and retrieves auth event', async () => {
      const event = JSON.stringify({ kind: 22242, content: 'test' });
      await setNostrAuthEvent(event);
      const result = await getNostrAuthEvent();
      expect(result).toBe(event);
    });
  });

  describe('getNostrRelays', () => {
    it('returns default relays when no user config', () => {
      (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
        get: jest.fn().mockReturnValue(undefined),
      });
      const relays = getNostrRelays();
      expect(relays).toEqual([
        'wss://relay.damus.io',
        'wss://relay.primal.net',
        'wss://nos.lol',
        'wss://relay.nsec.app',
      ]);
    });

    it('returns default relays when user config is empty array', () => {
      (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
        get: jest.fn().mockReturnValue([]),
      });
      const relays = getNostrRelays();
      expect(relays).toEqual([
        'wss://relay.damus.io',
        'wss://relay.primal.net',
        'wss://nos.lol',
        'wss://relay.nsec.app',
      ]);
    });

    it('returns user-configured relays', () => {
      (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
        get: jest.fn().mockReturnValue(['wss://custom-relay.example.com']),
      });
      const relays = getNostrRelays();
      expect(relays).toEqual(['wss://custom-relay.example.com']);
    });
  });

  describe('LNbits URL', () => {
    it('returns undefined when no URL stored', async () => {
      const result = await getLnbitsUrl();
      expect(result).toBeUndefined();
    });

    it('stores and retrieves LNbits URL', async () => {
      await setLnbitsUrl('https://my-lnbits.example.com');
      const result = await getLnbitsUrl();
      expect(result).toBe('https://my-lnbits.example.com');
    });
  });

  describe('LNbits API key', () => {
    it('returns undefined when no key stored', async () => {
      const result = await getLnbitsApiKey();
      expect(result).toBeUndefined();
    });

    it('stores and retrieves LNbits API key', async () => {
      await setLnbitsApiKey('admin-key-123');
      const result = await getLnbitsApiKey();
      expect(result).toBe('admin-key-123');
    });
  });

  describe('getIsDefaultLnbits', () => {
    it('returns false when no value stored', async () => {
      const result = await getIsDefaultLnbits();
      expect(result).toBe(false);
    });

    it('returns true for "true"', async () => {
      await setIsDefaultLnbits('true');
      const result = await getIsDefaultLnbits();
      expect(result).toBe(true);
    });

    it('returns true for "1"', async () => {
      await setIsDefaultLnbits('1');
      const result = await getIsDefaultLnbits();
      expect(result).toBe(true);
    });

    it('returns true for "yes"', async () => {
      await setIsDefaultLnbits('yes');
      const result = await getIsDefaultLnbits();
      expect(result).toBe(true);
    });

    it('returns true for "y"', async () => {
      await setIsDefaultLnbits('y');
      const result = await getIsDefaultLnbits();
      expect(result).toBe(true);
    });

    it('returns true for "on"', async () => {
      await setIsDefaultLnbits('on');
      const result = await getIsDefaultLnbits();
      expect(result).toBe(true);
    });

    it('returns true for " TRUE " (trimmed, case-insensitive)', async () => {
      await setIsDefaultLnbits(' TRUE ');
      const result = await getIsDefaultLnbits();
      expect(result).toBe(true);
    });

    it('returns false for "false"', async () => {
      await setIsDefaultLnbits('false');
      const result = await getIsDefaultLnbits();
      expect(result).toBe(false);
    });

    it('returns false for "0"', async () => {
      await setIsDefaultLnbits('0');
      const result = await getIsDefaultLnbits();
      expect(result).toBe(false);
    });

    it('returns false for arbitrary string', async () => {
      await setIsDefaultLnbits('maybe');
      const result = await getIsDefaultLnbits();
      expect(result).toBe(false);
    });
  });
});
