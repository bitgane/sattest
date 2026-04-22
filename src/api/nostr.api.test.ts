import * as vscode from 'vscode';

// Mock heavy nostr-tools dependencies
jest.mock('nostr-tools', () => ({
  generateSecretKey: jest.fn().mockReturnValue(new Uint8Array(32).fill(1)),
  getPublicKey: jest.fn().mockReturnValue('mock-client-pubkey'),
  SimplePool: jest.fn().mockImplementation(() => ({
    ensureRelay: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
  })),
}));

jest.mock('nostr-tools/nip46', () => ({
  BunkerSigner: {
    fromURI: jest.fn(),
  },
  createNostrConnectURI: jest.fn().mockReturnValue('nostr+connect://mock-uri'),
}));

jest.mock('nostr-tools/utils', () => ({
  bytesToHex: jest
    .fn()
    .mockReturnValue('0101010101010101010101010101010101010101010101010101010101010101'),
}));

jest.mock('qrcode', () => ({
  toString: jest.fn().mockResolvedValue('<svg>mock-qr</svg>'),
}));

jest.mock('../state', () => ({
  getNostrClientSecret: jest.fn().mockResolvedValue(undefined),
  setNostrClientSecret: jest.fn().mockResolvedValue(undefined),
  getNostrRelays: jest.fn().mockReturnValue(['wss://relay.test.com']),
  setNostrAuthEvent: jest.fn().mockResolvedValue(undefined),
  setNostrUserPubkey: jest.fn().mockResolvedValue(undefined),
  setNostrUserHandle: jest.fn().mockResolvedValue(undefined),
  initializeSecrets: jest.fn(),
}));

import { connectNostr, resolveNostrInfoFromBunkerSigner } from './nostr.api.js';
import { BunkerSigner } from 'nostr-tools/nip46';
import { SimplePool } from 'nostr-tools';
import { getNostrClientSecret } from '../state.js';

describe('connectNostr', () => {
  let mockContext: vscode.ExtensionContext;
  let mockEmitter: vscode.EventEmitter<void>;

  beforeEach(() => {
    mockContext = {
      secrets: {
        get: jest.fn().mockResolvedValue(undefined),
        store: jest.fn().mockResolvedValue(undefined),
      },
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;
    mockEmitter = new vscode.EventEmitter<void>();
  });

  it('creates webview panel with QR code', async () => {
    // Make BunkerSigner timeout immediately
    (BunkerSigner.fromURI as jest.Mock).mockRejectedValue(new Error('Timeout'));

    await connectNostr(mockContext, mockEmitter);

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      'nostrConnect',
      'Connect to Nostr',
      expect.anything(),
      expect.objectContaining({ enableScripts: true })
    );
  });

  it('generates new client secret when none stored', async () => {
    (getNostrClientSecret as jest.Mock).mockResolvedValue(undefined);
    (BunkerSigner.fromURI as jest.Mock).mockRejectedValue(new Error('Timeout'));

    await connectNostr(mockContext, mockEmitter);

    // Should have been called to set a new secret
    const { setNostrClientSecret } = require('../state');
    expect(setNostrClientSecret).toHaveBeenCalled();
  });

  it('reuses stored client secret', async () => {
    (getNostrClientSecret as jest.Mock).mockResolvedValue(
      'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'
    );
    (BunkerSigner.fromURI as jest.Mock).mockRejectedValue(new Error('Timeout'));

    await connectNostr(mockContext, mockEmitter);

    const { setNostrClientSecret } = require('../state');
    expect(setNostrClientSecret).not.toHaveBeenCalled();
  });

  it('returns undefined when signer times out', async () => {
    (BunkerSigner.fromURI as jest.Mock).mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10))
    );

    const result = await connectNostr(mockContext, mockEmitter);
    expect(result).toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Nostr connection failed')
    );
  });
});

describe('resolveNostrInfoFromBunkerSigner', () => {
  let mockPanel: any;
  let mockPool: any;
  let mockContext: vscode.ExtensionContext;

  beforeEach(() => {
    mockPanel = {
      webview: {
        html: '<p id="status" class="status">Waiting...</p>',
        onDidReceiveMessage: jest.fn().mockReturnValue({ dispose: jest.fn() }),
      },
      dispose: jest.fn(),
    };
    mockPool = new SimplePool();
    mockContext = {
      secrets: {
        get: jest.fn().mockResolvedValue(undefined),
        store: jest.fn().mockResolvedValue(undefined),
      },
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;
  });

  it('resolves user info on successful signer connection', async () => {
    const mockBunker = {
      getPublicKey: jest.fn().mockResolvedValue('user-pubkey-hex'),
      signEvent: jest.fn().mockResolvedValue({ kind: 22242, sig: 'fake-sig' }),
    };
    (BunkerSigner.fromURI as jest.Mock).mockResolvedValue(mockBunker);
    mockPool.get.mockResolvedValue({
      content: JSON.stringify({ name: 'alice' }),
    });

    const result = await resolveNostrInfoFromBunkerSigner(
      new Uint8Array(32),
      'nostr+connect://test',
      ['wss://relay.test.com'],
      mockPool,
      mockContext,
      mockPanel
    );

    expect(result).toEqual({
      userPubkey: 'user-pubkey-hex',
      userHandle: '@alice',
    });
  });

  it('uses fallback handle when no profile found', async () => {
    const mockBunker = {
      getPublicKey: jest.fn().mockResolvedValue('abcdef1234567890abcdef'),
      signEvent: jest.fn().mockResolvedValue({ kind: 22242, sig: 'fake-sig' }),
    };
    (BunkerSigner.fromURI as jest.Mock).mockResolvedValue(mockBunker);
    mockPool.get.mockResolvedValue(null);

    const result = await resolveNostrInfoFromBunkerSigner(
      new Uint8Array(32),
      'nostr+connect://test',
      ['wss://relay.test.com'],
      mockPool,
      mockContext,
      mockPanel
    );

    expect(result?.userPubkey).toBe('abcdef1234567890abcdef');
    expect(result?.userHandle).toContain('abcdef1234');
  });

  it('handles malformed profile JSON gracefully', async () => {
    const mockBunker = {
      getPublicKey: jest.fn().mockResolvedValue('pubkey123456789012345'),
      signEvent: jest.fn().mockResolvedValue({ kind: 22242, sig: 'fake' }),
    };
    (BunkerSigner.fromURI as jest.Mock).mockResolvedValue(mockBunker);
    mockPool.get.mockResolvedValue({ content: 'invalid json{{{' });

    const result = await resolveNostrInfoFromBunkerSigner(
      new Uint8Array(32),
      'nostr+connect://test',
      ['wss://relay.test.com'],
      mockPool,
      mockContext,
      mockPanel
    );

    expect(result).toBeDefined();
    // Falls back to truncated pubkey with @ prefix
    expect(result?.userHandle).toMatch(/^@/);
  });

  it('returns undefined on error', async () => {
    (BunkerSigner.fromURI as jest.Mock).mockRejectedValue(new Error('Connection refused'));

    const result = await resolveNostrInfoFromBunkerSigner(
      new Uint8Array(32),
      'nostr+connect://test',
      ['wss://relay.test.com'],
      mockPool,
      mockContext,
      mockPanel
    );

    expect(result).toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Nostr connection failed')
    );
  });

  it('prepends @ to handle if missing', async () => {
    const mockBunker = {
      getPublicKey: jest.fn().mockResolvedValue('user-pubkey'),
      signEvent: jest.fn().mockResolvedValue({ kind: 22242, sig: 'fake' }),
    };
    (BunkerSigner.fromURI as jest.Mock).mockResolvedValue(mockBunker);
    mockPool.get.mockResolvedValue({
      content: JSON.stringify({ name: 'bob' }),
    });

    const result = await resolveNostrInfoFromBunkerSigner(
      new Uint8Array(32),
      'nostr+connect://test',
      ['wss://relay.test.com'],
      mockPool,
      mockContext,
      mockPanel
    );

    expect(result?.userHandle).toBe('@bob');
  });

  it('does not double-prepend @ to handle', async () => {
    const mockBunker = {
      getPublicKey: jest.fn().mockResolvedValue('user-pubkey'),
      signEvent: jest.fn().mockResolvedValue({ kind: 22242, sig: 'fake' }),
    };
    (BunkerSigner.fromURI as jest.Mock).mockResolvedValue(mockBunker);
    mockPool.get.mockResolvedValue({
      content: JSON.stringify({ name: '@alice' }),
    });

    const result = await resolveNostrInfoFromBunkerSigner(
      new Uint8Array(32),
      'nostr+connect://test',
      ['wss://relay.test.com'],
      mockPool,
      mockContext,
      mockPanel
    );

    expect(result?.userHandle).toBe('@alice');
  });
});
