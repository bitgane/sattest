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
  // Default to "no identity" so the connected-banner branch in connectNostr
  // stays out of the way for unrelated tests; individual tests can override.
  getNostrUserPubkey: jest.fn().mockResolvedValue(undefined),
  getNostrUserHandle: jest.fn().mockResolvedValue(undefined),
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

  it('starts the signer subscription before revealing the QR (anti "connect twice")', async () => {
    // fromURI rejects (so connectNostr eventually finishes), but the rejection
    // only surfaces after the settle — giving us a window to observe ordering.
    (BunkerSigner.fromURI as jest.Mock).mockRejectedValue(new Error('Timeout'));
    const panelResults = (vscode.window.createWebviewPanel as jest.Mock).mock.results;

    const connectPromise = connectNostr(mockContext, mockEmitter);

    // Flush connectNostr's setup microtasks (relay/secret/handle lookups + QR
    // render) so the placeholder is painted and fromURI has started — but the
    // 750ms macrotask settle that gates the QR reveal has NOT elapsed.
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
    }

    const html = panelResults.at(-1)!.value.webview.html as string;
    expect(BunkerSigner.fromURI).toHaveBeenCalled(); // subscription dispatched
    expect(html).toContain('Establishing secure connection'); // placeholder shown
    expect(html).not.toContain('qr-container'); // QR deferred until after settle

    await connectPromise; // let it finish (settle → reject → fail path) cleanly
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

  it('renders "Connected as @<handle>" banner when an identity is already active', async () => {
    const state = require('../state');
    (state.getNostrUserPubkey as jest.Mock).mockResolvedValue('a'.repeat(64));
    (state.getNostrUserHandle as jest.Mock).mockResolvedValue('bitgane');
    (BunkerSigner.fromURI as jest.Mock).mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5))
    );

    const panel = (vscode.window.createWebviewPanel as jest.Mock).mock.results[0]?.value;
    await connectNostr(mockContext, mockEmitter);

    const html = (vscode.window.createWebviewPanel as jest.Mock).mock.results.at(-1)!.value
      .webview.html as string;
    expect(html).toContain('Connected as @bitgane');
    expect(html).toContain('class="connected"');
    void panel;
  });

  it('falls back to a shortened pubkey in the banner when no handle is set', async () => {
    const state = require('../state');
    const pk = 'b'.repeat(64);
    (state.getNostrUserPubkey as jest.Mock).mockResolvedValue(pk);
    (state.getNostrUserHandle as jest.Mock).mockResolvedValue(undefined);
    (BunkerSigner.fromURI as jest.Mock).mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5))
    );

    await connectNostr(mockContext, mockEmitter);

    const html = (vscode.window.createWebviewPanel as jest.Mock).mock.results.at(-1)!.value
      .webview.html as string;
    expect(html).toContain(`${pk.slice(0, 8)}…${pk.slice(-4)}`);
  });

  it('omits the connected banner entirely when no identity is active', async () => {
    const state = require('../state');
    (state.getNostrUserPubkey as jest.Mock).mockResolvedValue(undefined);
    (state.getNostrUserHandle as jest.Mock).mockResolvedValue(undefined);
    (BunkerSigner.fromURI as jest.Mock).mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5))
    );

    await connectNostr(mockContext, mockEmitter);

    const html = (vscode.window.createWebviewPanel as jest.Mock).mock.results.at(-1)!.value
      .webview.html as string;
    expect(html).not.toContain('class="connected"');
    expect(html).not.toContain('Connected as');
  });

  it('renders the generic notice when no identity is connected', async () => {
    const state = require('../state');
    (state.getNostrUserPubkey as jest.Mock).mockResolvedValue(undefined);
    (state.getNostrUserHandle as jest.Mock).mockResolvedValue(undefined);
    (BunkerSigner.fromURI as jest.Mock).mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5))
    );

    await connectNostr(mockContext, mockEmitter, {
      noticeMessage: 'Refresh your Nostr login to complete your wallet connection.',
      noticeMessageWithIdentity: (id) => `Refresh your Nostr connection as ${id} to complete your wallet connection.`,
    });

    const html = (vscode.window.createWebviewPanel as jest.Mock).mock.results.at(-1)!.value
      .webview.html as string;
    expect(html).toContain('class="notice-action"');
    // No identity → generic message, and no green banner.
    expect(html).toContain('Refresh your Nostr login to complete your wallet connection.');
    expect(html).not.toContain('class="connected"');
  });

  it('folds the identity into the yellow notice and suppresses the green banner', async () => {
    const state = require('../state');
    (state.getNostrUserPubkey as jest.Mock).mockResolvedValue('a'.repeat(64));
    (state.getNostrUserHandle as jest.Mock).mockResolvedValue('bitgane');
    (BunkerSigner.fromURI as jest.Mock).mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5))
    );

    await connectNostr(mockContext, mockEmitter, {
      noticeMessage: 'Refresh your Nostr login to complete your wallet connection.',
      noticeMessageWithIdentity: (id) => `Refresh your Nostr connection as ${id} to complete your wallet connection.`,
    });

    const html = (vscode.window.createWebviewPanel as jest.Mock).mock.results.at(-1)!.value
      .webview.html as string;
    // Identity folded into the yellow notice…
    expect(html).toContain('class="notice-action"');
    expect(html).toContain('Refresh your Nostr connection as @bitgane to complete your wallet connection.');
    // …and the separate green "Connected as" banner is suppressed.
    expect(html).not.toContain('class="connected"');
    expect(html).not.toContain('Connected as');
  });

  it('falls back to a shortened pubkey in the notice when no handle is set', async () => {
    const state = require('../state');
    const pk = 'b'.repeat(64);
    (state.getNostrUserPubkey as jest.Mock).mockResolvedValue(pk);
    (state.getNostrUserHandle as jest.Mock).mockResolvedValue(undefined);
    (BunkerSigner.fromURI as jest.Mock).mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5))
    );

    await connectNostr(mockContext, mockEmitter, {
      noticeMessage: 'Refresh your Nostr login to complete your wallet connection.',
      noticeMessageWithIdentity: (id) => `Refresh your Nostr connection as ${id} to complete your wallet connection.`,
    });

    const html = (vscode.window.createWebviewPanel as jest.Mock).mock.results.at(-1)!.value
      .webview.html as string;
    expect(html).toContain(`Refresh your Nostr connection as ${pk.slice(0, 8)}…${pk.slice(-4)} to complete your wallet connection.`);
    expect(html).not.toContain('class="connected"');
  });

  it('omits the notice-action banner when no noticeMessage is provided', async () => {
    (BunkerSigner.fromURI as jest.Mock).mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5))
    );

    await connectNostr(mockContext, mockEmitter);

    const html = (vscode.window.createWebviewPanel as jest.Mock).mock.results.at(-1)!.value
      .webview.html as string;
    expect(html).not.toContain('class="notice-action"');
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
      mockPanel,
      undefined, // revealQr
      0 // settleMs: skip the relay-settle delay in unit tests
    );

    expect(result).toEqual({
      userPubkey: 'user-pubkey-hex',
      userHandle: '@alice',
    });
  });

  it('rewrites the panel to a minimal "Connected as <handle>" success view on pairing', async () => {
    // After a successful pair (especially when swapping identities) the panel
    // should drop the QR / copy-URI / scan instructions so the user can't
    // accidentally pair a third identity in the seconds before auto-close.
    const mockBunker = {
      getPublicKey: jest.fn().mockResolvedValue('new-pubkey-hex'),
      signEvent: jest.fn().mockResolvedValue({ kind: 22242, sig: 'fake-sig' }),
    };
    (BunkerSigner.fromURI as jest.Mock).mockResolvedValue(mockBunker);
    mockPool.get.mockResolvedValue({ content: JSON.stringify({ name: 'newuser' }) });
    // Pre-populate the panel HTML with the things that should be stripped.
    mockPanel.webview.html =
      '<svg class="qr-container"></svg><button id="copyUriBtn">Copy URI</button>' +
      '<div class="notice">Scan this QR with...</div>' +
      '<p id="status" class="status">Waiting...</p>';

    await resolveNostrInfoFromBunkerSigner(
      new Uint8Array(32),
      'nostr+connect://test',
      ['wss://relay.test.com'],
      mockPool,
      mockContext,
      mockPanel,
      undefined, // revealQr
      0 // settleMs: skip the relay-settle delay in unit tests
    );

    const html = mockPanel.webview.html as string;
    expect(html).toContain('Connected as @newuser');
    expect(html).toContain('class="connected"');
    expect(html).toContain('Closing in a few seconds');
    // QR / copy-URI / scan instructions all gone.
    expect(html).not.toContain('qr-container');
    expect(html).not.toContain('copyUriBtn');
    expect(html).not.toContain('Scan this QR');
  });

  it('keeps the panel visible briefly before disposing on success', async () => {
    jest.useFakeTimers();
    try {
      const mockBunker = {
        getPublicKey: jest.fn().mockResolvedValue('pk'),
        signEvent: jest.fn().mockResolvedValue({ kind: 22242, sig: 'fake-sig' }),
      };
      (BunkerSigner.fromURI as jest.Mock).mockResolvedValue(mockBunker);
      mockPool.get.mockResolvedValue({ content: JSON.stringify({ name: 'x' }) });

      await resolveNostrInfoFromBunkerSigner(
        new Uint8Array(32),
        'nostr+connect://test',
        ['wss://relay.test.com'],
        mockPool,
        mockContext,
        mockPanel,
        undefined, // revealQr
        0 // settleMs: skip the relay-settle delay in unit tests
      );

      expect(mockPanel.dispose).not.toHaveBeenCalled();
      // 4-second hold so the user sees the swap. Exact value isn't part of
      // the public contract — the assertion just guards against a regression
      // back to "dispose immediately".
      jest.advanceTimersByTime(3999);
      expect(mockPanel.dispose).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(mockPanel.dispose).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
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
      mockPanel,
      undefined, // revealQr
      0 // settleMs: skip the relay-settle delay in unit tests
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
      mockPanel,
      undefined, // revealQr
      0 // settleMs: skip the relay-settle delay in unit tests
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
      mockPanel,
      undefined, // revealQr
      0 // settleMs: skip the relay-settle delay in unit tests
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
      mockPanel,
      undefined, // revealQr
      0 // settleMs: skip the relay-settle delay in unit tests
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
      mockPanel,
      undefined, // revealQr
      0 // settleMs: skip the relay-settle delay in unit tests
    );

    expect(result?.userHandle).toBe('@alice');
  });
});
