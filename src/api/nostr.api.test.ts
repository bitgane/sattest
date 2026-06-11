import * as vscode from 'vscode';

// Mock heavy nostr-tools dependencies. SimplePool returns a SHARED singleton so
// tests can drive the handshake subscription that connectNostr's internal pool
// opens (`new SimplePool()` inside connectNostr === the same object tests get).
jest.mock('nostr-tools', () => {
  const sharedPool = {
    ensureRelay: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    subscribe: jest.fn().mockReturnValue({ close: jest.fn() }),
  };
  return {
    generateSecretKey: jest.fn().mockReturnValue(new Uint8Array(32).fill(1)),
    getPublicKey: jest.fn().mockReturnValue('mock-client-pubkey'),
    SimplePool: jest.fn().mockImplementation(() => sharedPool),
    nip04: { decrypt: jest.fn() },
    nip44: { decrypt: jest.fn(), getConversationKey: jest.fn() },
  };
});

jest.mock('nostr-tools/nip46', () => ({
  BunkerSigner: {
    fromURI: jest.fn(),
    fromBunker: jest.fn(),
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
import { SimplePool, nip44 } from 'nostr-tools';
import { getNostrClientSecret } from '../state.js';

// The SimplePool mock returns a shared singleton — grab it for driving the
// handshake subscription from tests.
const sharedPool = new SimplePool() as unknown as {
  ensureRelay: jest.Mock;
  get: jest.Mock;
  subscribe: jest.Mock;
};

/** Make the signer handshake fail immediately (subscribe throws). */
function handshakeFails(error: Error = new Error('Timeout')) {
  sharedPool.subscribe.mockImplementation(() => {
    throw error;
  });
}

/**
 * Make the signer handshake succeed: the subscription delivers one encrypted
 * connect event (via microtask, so it works under fake timers too) and nip44
 * decrypts it to `{ result }`.
 */
function handshakeSucceeds(result: string = 'ack', remotePubkey = 'remote-signer-pubkey') {
  (nip44.getConversationKey as jest.Mock).mockReturnValue(new Uint8Array(32));
  (nip44.decrypt as jest.Mock).mockReturnValue(JSON.stringify({ result }));
  sharedPool.subscribe.mockImplementation((_relays: unknown, _filter: unknown, opts: any) => {
    Promise.resolve().then(() => opts.onevent({ pubkey: remotePubkey, content: 'enc' }));
    return { close: jest.fn() };
  });
}

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
    // Implementations persist across tests (global setup only clears calls) —
    // reset the shared pool's subscription to a benign default.
    sharedPool.subscribe.mockReset().mockReturnValue({ close: jest.fn() });
    sharedPool.ensureRelay.mockResolvedValue(undefined);
  });

  it('creates webview panel with QR code', async () => {
    // Make BunkerSigner timeout immediately
    handshakeFails();

    await connectNostr(mockContext, mockEmitter);

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      'nostrConnect',
      'Connect to Nostr',
      expect.anything(),
      expect.objectContaining({ enableScripts: true })
    );
  });

  it('starts the signer subscription before revealing the QR (anti "connect twice")', async () => {
    // The handshake rejects (so connectNostr eventually finishes), but the
    // rejection only surfaces after the settle — a window to observe ordering.
    handshakeFails();
    const panelResults = (vscode.window.createWebviewPanel as jest.Mock).mock.results;

    const connectPromise = connectNostr(mockContext, mockEmitter);

    // Flush connectNostr's setup microtasks (relay/secret/handle lookups + QR
    // render) so the placeholder is painted and the handshake subscription has
    // started — but the 750ms macrotask settle gating the QR has NOT elapsed.
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
    }

    const html = panelResults.at(-1)!.value.webview.html as string;
    expect(sharedPool.subscribe).toHaveBeenCalled(); // subscription dispatched
    expect(html).toContain('Establishing secure connection'); // placeholder shown
    expect(html).not.toContain('qr-container'); // QR deferred until after settle

    await connectPromise; // let it finish (settle → reject → fail path) cleanly
  });

  it('generates new client secret when none stored', async () => {
    (getNostrClientSecret as jest.Mock).mockResolvedValue(undefined);
    handshakeFails();

    await connectNostr(mockContext, mockEmitter);

    // Should have been called to set a new secret
    const { setNostrClientSecret } = require('../state');
    expect(setNostrClientSecret).toHaveBeenCalled();
  });

  it('reuses stored client secret', async () => {
    (getNostrClientSecret as jest.Mock).mockResolvedValue(
      'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'
    );
    handshakeFails();

    await connectNostr(mockContext, mockEmitter);

    const { setNostrClientSecret } = require('../state');
    expect(setNostrClientSecret).not.toHaveBeenCalled();
  });

  it('renders "Connected as @<handle>" banner when an identity is already active', async () => {
    const state = require('../state');
    (state.getNostrUserPubkey as jest.Mock).mockResolvedValue('a'.repeat(64));
    (state.getNostrUserHandle as jest.Mock).mockResolvedValue('bitgane');
    handshakeFails();

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
    handshakeFails();

    await connectNostr(mockContext, mockEmitter);

    const html = (vscode.window.createWebviewPanel as jest.Mock).mock.results.at(-1)!.value
      .webview.html as string;
    expect(html).toContain(`${pk.slice(0, 8)}…${pk.slice(-4)}`);
  });

  it('omits the connected banner entirely when no identity is active', async () => {
    const state = require('../state');
    (state.getNostrUserPubkey as jest.Mock).mockResolvedValue(undefined);
    (state.getNostrUserHandle as jest.Mock).mockResolvedValue(undefined);
    handshakeFails();

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
    handshakeFails();

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
    handshakeFails();

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
    handshakeFails();

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
    handshakeFails();

    await connectNostr(mockContext, mockEmitter);

    const html = (vscode.window.createWebviewPanel as jest.Mock).mock.results.at(-1)!.value
      .webview.html as string;
    expect(html).not.toContain('class="notice-action"');
  });

  it('returns undefined when signer times out', async () => {
    handshakeFails(new Error('Timeout'));

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
    mockPool = new SimplePool(); // the shared singleton
    mockContext = {
      secrets: {
        get: jest.fn().mockResolvedValue(undefined),
        store: jest.fn().mockResolvedValue(undefined),
      },
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;
    // Reset handshake plumbing between tests (implementations persist).
    sharedPool.subscribe.mockReset().mockReturnValue({ close: jest.fn() });
    mockPool.get = jest.fn().mockResolvedValue(null);
  });

  it('accepts a signer that echoes the secret (spec behavior)', async () => {
    const mockBunker = {
      getPublicKey: jest.fn().mockResolvedValue('pk'),
      signEvent: jest.fn().mockResolvedValue({ kind: 22242, sig: 'fake-sig' }),
    };
    (BunkerSigner.fromBunker as jest.Mock).mockReturnValue(mockBunker);
    handshakeSucceeds('s3cr3t'); // echoes the secret, not "ack"
    mockPool.get.mockResolvedValue(null);

    const result = await resolveNostrInfoFromBunkerSigner(
      new Uint8Array(32),
      'nostr+connect://test?secret=s3cr3t',
      ['wss://relay.test.com'],
      mockPool,
      mockContext,
      mockPanel,
      undefined,
      0
    );

    expect(result?.userPubkey).toBe('pk');
    // The signer session is built from the pubkey that answered the handshake.
    expect(BunkerSigner.fromBunker).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pubkey: 'remote-signer-pubkey', secret: 's3cr3t' }),
      expect.objectContaining({ pool: mockPool })
    );
  });

  it('falls back to NIP-04 when NIP-44 decryption fails (signer interop)', async () => {
    const { nip04 } = require('nostr-tools');
    const mockBunker = {
      getPublicKey: jest.fn().mockResolvedValue('pk'),
      signEvent: jest.fn().mockResolvedValue({ kind: 22242, sig: 'fake-sig' }),
    };
    (BunkerSigner.fromBunker as jest.Mock).mockReturnValue(mockBunker);
    mockPool.get.mockResolvedValue(null);

    // NIP-44 decrypt throws (signer encrypted the response with NIP-04)…
    (nip44.getConversationKey as jest.Mock).mockReturnValue(new Uint8Array(32));
    (nip44.decrypt as jest.Mock).mockImplementation(() => {
      throw new Error('invalid payload');
    });
    // …NIP-04 succeeds with the legacy ack reply.
    (nip04.decrypt as jest.Mock).mockReturnValue(JSON.stringify({ result: 'ack' }));
    sharedPool.subscribe.mockImplementation((_r: unknown, _f: unknown, opts: any) => {
      Promise.resolve().then(() => opts.onevent({ pubkey: 'remote-signer-pubkey', content: 'enc' }));
      return { close: jest.fn() };
    });

    const result = await resolveNostrInfoFromBunkerSigner(
      new Uint8Array(32),
      'nostr+connect://test',
      ['wss://relay.test.com'],
      mockPool,
      mockContext,
      mockPanel,
      undefined,
      0
    );

    expect(result?.userPubkey).toBe('pk');
    expect(nip04.decrypt).toHaveBeenCalled();
  });

  it('resolves user info on successful signer connection', async () => {
    const mockBunker = {
      getPublicKey: jest.fn().mockResolvedValue('user-pubkey-hex'),
      signEvent: jest.fn().mockResolvedValue({ kind: 22242, sig: 'fake-sig' }),
    };
    (BunkerSigner.fromBunker as jest.Mock).mockReturnValue(mockBunker);
    handshakeSucceeds();
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
    (BunkerSigner.fromBunker as jest.Mock).mockReturnValue(mockBunker);
    handshakeSucceeds();
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
      (BunkerSigner.fromBunker as jest.Mock).mockReturnValue(mockBunker);
    handshakeSucceeds();
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
    (BunkerSigner.fromBunker as jest.Mock).mockReturnValue(mockBunker);
    handshakeSucceeds();
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
    (BunkerSigner.fromBunker as jest.Mock).mockReturnValue(mockBunker);
    handshakeSucceeds();
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
    handshakeFails(new Error('Connection refused'));

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
    (BunkerSigner.fromBunker as jest.Mock).mockReturnValue(mockBunker);
    handshakeSucceeds();
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
    (BunkerSigner.fromBunker as jest.Mock).mockReturnValue(mockBunker);
    handshakeSucceeds();
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
