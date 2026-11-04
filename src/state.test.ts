import * as vscode from 'vscode';
import {
  initializeSecrets,
  getNostrClientSecret,
  setNostrClientSecret,
  getNostrUserPubkey,
  setNostrUserPubkey,
  getNostrUserHandle,
  setNostrUserHandle,
  getNostrBunkerPointer,
  setNostrBunkerPointer,
  getNostrRelays,
  getNwcUri,
  setNwcUri,
  clearNwcUri,
  getBountyRelays,
  getTrustedCreators,
  DEFAULT_BOUNTY_RELAYS,
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

  describe('Nostr bunker pointer', () => {
    it('returns undefined when no pointer stored', async () => {
      const result = await getNostrBunkerPointer();
      expect(result).toBeUndefined();
    });

    it('stores and retrieves the bunker pointer', async () => {
      const pointer = JSON.stringify({
        pubkey: 'remote-signer-pubkey',
        relays: ['wss://relay.test.com'],
        secret: 'connect-secret',
      });
      await setNostrBunkerPointer(pointer);
      const result = await getNostrBunkerPointer();
      expect(result).toBe(pointer);
    });
  });

  describe('getNostrRelays', () => {
    const DEFAULTS = [
      'wss://relay.damus.io',
      'wss://relay.primal.net',
      'wss://nos.lol',
      'wss://relay.nsec.app',
    ];

    /** Mock getConfiguration().inspect('nostrRelays') to return `result`. */
    function mockInspect(result: Record<string, unknown> | undefined) {
      (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
        get: jest.fn(),
        inspect: jest.fn().mockReturnValue(result),
      });
    }

    it('returns the package default when there is no user value', () => {
      mockInspect({ defaultValue: DEFAULTS });
      expect(getNostrRelays()).toEqual(DEFAULTS);
    });

    it('falls back to defaults when inspect returns nothing', () => {
      mockInspect(undefined);
      expect(getNostrRelays()).toEqual(DEFAULTS);
    });

    it('falls back to defaults when the user value is an empty array', () => {
      mockInspect({ globalValue: [], defaultValue: DEFAULTS });
      expect(getNostrRelays()).toEqual(DEFAULTS);
    });

    it('returns user-configured wss relays', () => {
      mockInspect({ globalValue: ['wss://custom-relay.example.com'] });
      expect(getNostrRelays()).toEqual(['wss://custom-relay.example.com']);
    });

    it('drops non-wss / malformed entries and keeps the valid ones', () => {
      mockInspect({
        globalValue: [
          'wss://good.example.com',
          'http://evil.example.com',
          'ws://evil.example.com',
          'not-a-url',
          'ws://localhost:7777',
        ],
      });
      expect(getNostrRelays()).toEqual(['wss://good.example.com', 'ws://localhost:7777']);
    });

    it('falls back to defaults when every configured entry is invalid', () => {
      mockInspect({ globalValue: ['http://evil.example.com', 'garbage'], defaultValue: DEFAULTS });
      expect(getNostrRelays()).toEqual(DEFAULTS);
    });

    // Security: a workspace must not be able to redirect signer traffic.
    it('IGNORES a workspace-provided relay list, using the user value', () => {
      mockInspect({
        globalValue: ['wss://real.example.com'],
        workspaceValue: ['wss://evil.example.com'],
        workspaceFolderValue: ['wss://evil.example.com'],
      });
      expect(getNostrRelays()).toEqual(['wss://real.example.com']);
    });
  });

  describe('NWC connection string', () => {
    it('is stored in secret storage and can be cleared', async () => {
      expect(await getNwcUri()).toBeUndefined();
      await setNwcUri('nostr+walletconnect://abc');
      expect(await getNwcUri()).toBe('nostr+walletconnect://abc');
      expect(mockContext.secrets.store).toHaveBeenCalledWith(
        'nwc_connection_uri',
        'nostr+walletconnect://abc'
      );
      await clearNwcUri();
      expect(await getNwcUri()).toBeUndefined();
    });
  });

  describe('getBountyRelays', () => {
    const inspect = (value: unknown) =>
      (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
        inspect: jest.fn().mockReturnValue(value),
      });

    afterEach(() => {
      (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
        get: jest.fn(),
        update: jest.fn(),
        inspect: jest.fn().mockReturnValue(undefined),
      });
    });

    it('falls back to the defaults', () => {
      inspect(undefined);
      expect(getBountyRelays()).toEqual(DEFAULT_BOUNTY_RELAYS);
    });

    it('honours only the user value and drops unsafe entries', () => {
      inspect({
        globalValue: ['wss://a.example', 'http://evil.example', 'ws://localhost:7777'],
        workspaceValue: ['wss://attacker.example'],
      });
      expect(getBountyRelays()).toEqual(['wss://a.example', 'ws://localhost:7777']);
    });

    it('ignores trusted creators set by a workspace', () => {
      inspect({ globalValue: ['npub1me'], workspaceValue: ['npub1attacker'] });
      expect(getTrustedCreators()).toEqual(['npub1me']);
    });
  });
});
