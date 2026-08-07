import * as vscode from 'vscode';

// Mock heavy nostr-tools dependencies. SimplePool returns a SHARED singleton so
// tests can drive the handshake subscription that connectNostr's internal pool
// opens (`new SimplePool()` inside connectNostr === the same object tests get).
jest.mock('nostr-tools', () => {
  const sharedPool = {
    ensureRelay: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    subscribe: jest.fn().mockReturnValue({ close: jest.fn() }),
    close: jest.fn(),
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
  getNostrBunkerPointer: jest.fn().mockResolvedValue(undefined),
  setNostrBunkerPointer: jest.fn().mockResolvedValue(undefined),
  setNostrUserPubkey: jest.fn().mockResolvedValue(undefined),
  setNostrUserHandle: jest.fn().mockResolvedValue(undefined),
  // Default to "no identity" so the connected-banner branch in connectNostr
  // stays out of the way for unrelated tests; individual tests can override.
  getNostrUserPubkey: jest.fn().mockResolvedValue(undefined),
  getNostrUserHandle: jest.fn().mockResolvedValue(undefined),
  initializeSecrets: jest.fn(),
}));

import {
  connectNostr,
  isPubkeyFallbackHandle,
  refreshNostrHandleIfStale,
  resolveNostrInfoFromBunkerSigner,
  signMoneyAuthEvent,
} from './nostr.api.js';
import { BunkerSigner } from 'nostr-tools/nip46';
import { SimplePool, nip44 } from 'nostr-tools';
import { getNostrClientSecret, getNostrBunkerPointer } from '../state.js';

// The SimplePool mock returns a shared singleton — grab it for driving the
// handshake subscription from tests.
const sharedPool = new SimplePool() as unknown as {
  ensureRelay: jest.Mock;
  get: jest.Mock;
  subscribe: jest.Mock;
  close: jest.Mock;
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
 *
 * The default result echoes the connect secret (`s3cr3t`), which is what the
 * production code REQUIRES: a legacy `ack` reply is rejected as a possible
 * pairing-hijack attempt. Pass an explicit result only to test rejection paths.
 */
function handshakeSucceeds(result: string = 's3cr3t', remotePubkey = 'remote-signer-pubkey') {
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

  it('requests signing permissions up front in the connect URI', async () => {
    const { createNostrConnectURI } = require('nostr-tools/nip46');
    handshakeFails();

    await connectNostr(mockContext, mockEmitter);

    // Without pre-granted perms the signer only allows what the user taps
    // through at pairing, so a later background sign (every money call) can
    // stall on an approval prompt nobody sees.
    const params = (createNostrConnectURI as jest.Mock).mock.calls.at(-1)![0];
    expect(params.perms).toEqual(expect.arrayContaining(['sign_event:22242']));
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
    });

    const html = (vscode.window.createWebviewPanel as jest.Mock).mock.results.at(-1)!.value
      .webview.html as string;
    expect(html).toContain('class="notice-action"');
    // No identity → generic message, and no green banner.
    expect(html).toContain('Refresh your Nostr login to complete your wallet connection.');
    expect(html).not.toContain('class="connected"');
  });

  it('suppresses the green "Connected as" banner while the refresh notice is showing', async () => {
    const state = require('../state');
    (state.getNostrUserPubkey as jest.Mock).mockResolvedValue('a'.repeat(64));
    (state.getNostrUserHandle as jest.Mock).mockResolvedValue('bitgane');
    handshakeFails();

    await connectNostr(mockContext, mockEmitter, {
      noticeMessage: 'Refresh your Nostr login to complete your wallet connection.',
    });

    const html = (vscode.window.createWebviewPanel as jest.Mock).mock.results.at(-1)!.value
      .webview.html as string;
    // The refresh/reconnect notice is the whole point of this flow, so it wins…
    expect(html).toContain('class="notice-action"');
    expect(html).toContain('Refresh your Nostr login to complete your wallet connection.');
    // …and the green banner is suppressed — the two contradict each other at a
    // glance ("Connected as @alice" next to "Refresh your Nostr connection").
    expect(html).not.toContain('class="connected"');
    expect(html).not.toContain('Connected as @bitgane');
  });

  it('shows the green "Connected as" banner when no refresh notice is present', async () => {
    const state = require('../state');
    (state.getNostrUserPubkey as jest.Mock).mockResolvedValue('a'.repeat(64));
    (state.getNostrUserHandle as jest.Mock).mockResolvedValue('bitgane');
    handshakeFails();

    // Plain "Connect Nostr" (no noticeMessage) opened while already connected.
    await connectNostr(mockContext, mockEmitter);

    const html = (vscode.window.createWebviewPanel as jest.Mock).mock.results.at(-1)!.value
      .webview.html as string;
    expect(html).not.toContain('class="notice-action"');
    expect(html).toContain('class="connected"');
    expect(html).toContain('Connected as @bitgane');
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

  it('ignores a legacy "ack" response and waits for the secret echo (anti pairing-hijack)', async () => {
    // The attack: a malicious relay learns clientPubkey from our subscription
    // filter and fires an unauthenticated "ack" before the user's real signer
    // can answer. First response must NOT win — only the secret echo pairs.
    const mockBunker = {
      getPublicKey: jest.fn().mockResolvedValue('pk'),
      signEvent: jest.fn().mockResolvedValue({ kind: 22242, sig: 'fake-sig' }),
    };
    (BunkerSigner.fromBunker as jest.Mock).mockReturnValue(mockBunker);
    (nip44.getConversationKey as jest.Mock).mockReturnValue(new Uint8Array(32));
    (nip44.decrypt as jest.Mock)
      .mockReturnValueOnce(JSON.stringify({ result: 'ack' })) // attacker's response
      .mockReturnValueOnce(JSON.stringify({ result: 's3cr3t' })); // the real signer's echo
    sharedPool.subscribe.mockImplementation((_r: unknown, _f: unknown, opts: any) => {
      Promise.resolve()
        .then(() => opts.onevent({ pubkey: 'attacker-pubkey', content: 'enc' }))
        .then(() => opts.onevent({ pubkey: 'remote-signer-pubkey', content: 'enc' }));
      return { close: jest.fn() };
    });
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
    // The session is bound to the REAL signer, never to the ack sender.
    expect(BunkerSigner.fromBunker).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pubkey: 'remote-signer-pubkey' }),
      expect.anything()
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
    // …NIP-04 succeeds — and still has to echo the secret, like any response.
    (nip04.decrypt as jest.Mock).mockReturnValue(JSON.stringify({ result: 's3cr3t' }));
    sharedPool.subscribe.mockImplementation((_r: unknown, _f: unknown, opts: any) => {
      Promise.resolve().then(() => opts.onevent({ pubkey: 'remote-signer-pubkey', content: 'enc' }));
      return { close: jest.fn() };
    });

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
    expect(nip04.decrypt).toHaveBeenCalled();
  });

  it('resolves user info on successful signer connection', async () => {
    const signEvent = jest.fn().mockResolvedValue({ kind: 22242, sig: 'fake-sig' });
    const mockBunker = {
      getPublicKey: jest.fn().mockResolvedValue('user-pubkey-hex'),
      signEvent,
    };
    (BunkerSigner.fromBunker as jest.Mock).mockReturnValue(mockBunker);
    handshakeSucceeds();
    mockPool.get.mockResolvedValue({
      content: JSON.stringify({ name: 'alice' }),
    });

    const result = await resolveNostrInfoFromBunkerSigner(
      new Uint8Array(32),
      'nostr+connect://test?secret=s3cr3t',
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

    // M3: the signed auth event is bound to the backend via a `relay` tag so a
    // harvested credential can't be replayed against a different server.
    const signedArg = signEvent.mock.calls[0][0];
    expect(signedArg.kind).toBe(22242);
    const relayTag = signedArg.tags.find((t: string[]) => t[0] === 'relay');
    expect(relayTag).toBeDefined();
    expect(typeof relayTag[1]).toBe('string');
    expect(relayTag[1]).toMatch(/^https?:\/\//);

    // Only the read credential is signed at connect time (F4: the write
    // credential is minted per money call, not cached — see signMoneyAuthEvent
    // below). Exactly one signEvent call happened here.
    expect(signEvent).toHaveBeenCalledTimes(1);
    expect(signedArg.content).toBe('sattest-auth');

    // The bunker pointer is persisted so signMoneyAuthEvent can rebuild a
    // signer session later without re-scanning the connect QR.
    const { setNostrBunkerPointer } = require('../state');
    expect(setNostrBunkerPointer).toHaveBeenCalledTimes(1);
    const persistedPointer = JSON.parse((setNostrBunkerPointer as jest.Mock).mock.calls[0][0]);
    expect(persistedPointer).toMatchObject({
      pubkey: 'remote-signer-pubkey',
      relays: ['wss://relay.test.com'],
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
      'nostr+connect://test?secret=s3cr3t',
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
        'nostr+connect://test?secret=s3cr3t',
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
      'nostr+connect://test?secret=s3cr3t',
      ['wss://relay.test.com'],
      mockPool,
      mockContext,
      mockPanel,
      undefined, // revealQr
      0 // settleMs: skip the relay-settle delay in unit tests
    );

    expect(result?.userPubkey).toBe('abcdef1234567890abcdef');
    // A pubkey rendering, NOT dressed up as a handle with an "@".
    expect(result?.userHandle).toBe('abcdef12…cdef');
    expect(result?.userHandle).not.toMatch(/^@/);
    // Critically: the fallback must never be persisted — there's no refresh
    // path at connect time, so storing it would show hex in the banner forever.
    const { setNostrUserHandle } = require('../state');
    expect(setNostrUserHandle).not.toHaveBeenCalledWith(expect.stringContaining('abcdef12'));
  });

  it('queries the profile against the full configured relay set, with a maxWait', async () => {
    const mockBunker = {
      getPublicKey: jest.fn().mockResolvedValue('user-pubkey-hex'),
      signEvent: jest.fn().mockResolvedValue({ kind: 22242, sig: 'fake-sig' }),
    };
    (BunkerSigner.fromBunker as jest.Mock).mockReturnValue(mockBunker);
    handshakeSucceeds();
    const { getNostrRelays } = require('../state');
    // Configured set is wider than the relays that won the 5s connect race.
    (getNostrRelays as jest.Mock).mockReturnValue([
      'wss://relay.damus.io',
      'wss://relay.nsec.app',
    ]);
    mockPool.get.mockResolvedValue({ content: JSON.stringify({ name: 'alice' }) });

    await resolveNostrInfoFromBunkerSigner(
      new Uint8Array(32),
      'nostr+connect://test?secret=s3cr3t',
      ['wss://relay.nsec.app'], // only the signer relay connected in time
      mockPool,
      mockContext,
      mockPanel,
      undefined,
      0
    );

    const [relaysArg, filterArg, optsArg] = mockPool.get.mock.calls[0];
    // Regression: querying only the live (signer) relay is what made the
    // lookup miss and fall back to hex. The general relay must be included.
    expect(relaysArg).toEqual(expect.arrayContaining(['wss://relay.damus.io']));
    expect(filterArg).toEqual({ kinds: [0], authors: ['user-pubkey-hex'] });
    // Without maxWait the fastest empty relay's EOSE resolves the lookup null.
    expect(optsArg?.maxWait).toBeGreaterThan(0);
  });

  it('persists a resolved handle', async () => {
    const mockBunker = {
      getPublicKey: jest.fn().mockResolvedValue('user-pubkey-hex'),
      signEvent: jest.fn().mockResolvedValue({ kind: 22242, sig: 'fake-sig' }),
    };
    (BunkerSigner.fromBunker as jest.Mock).mockReturnValue(mockBunker);
    handshakeSucceeds();
    mockPool.get.mockResolvedValue({ content: JSON.stringify({ name: 'alice' }) });

    await resolveNostrInfoFromBunkerSigner(
      new Uint8Array(32),
      'nostr+connect://test?secret=s3cr3t',
      ['wss://relay.test.com'],
      mockPool,
      mockContext,
      mockPanel,
      undefined,
      0
    );

    const { setNostrUserHandle } = require('../state');
    expect(setNostrUserHandle).toHaveBeenCalledWith('@alice');
  });

  it('keeps the previously resolved handle when a re-connect lookup misses', async () => {
    const { getNostrUserPubkey, getNostrUserHandle, setNostrUserHandle } = require('../state');
    // Same identity as last time, and we already know its real name.
    (getNostrUserPubkey as jest.Mock).mockResolvedValue('user-pubkey-hex');
    (getNostrUserHandle as jest.Mock).mockResolvedValue('@alice');

    const mockBunker = {
      getPublicKey: jest.fn().mockResolvedValue('user-pubkey-hex'),
      signEvent: jest.fn().mockResolvedValue({ kind: 22242, sig: 'fake-sig' }),
    };
    (BunkerSigner.fromBunker as jest.Mock).mockReturnValue(mockBunker);
    handshakeSucceeds();
    mockPool.get.mockResolvedValue(null); // relay miss

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

    // Doesn't regress to hex, and doesn't rewrite storage.
    expect(result?.userHandle).toBe('@alice');
    expect(setNostrUserHandle).not.toHaveBeenCalled();
  });

  it("clears the stored handle when a different identity's name can't be resolved", async () => {
    const { getNostrUserPubkey, getNostrUserHandle, setNostrUserHandle } = require('../state');
    // Previously connected as alice; now connecting as someone else.
    (getNostrUserPubkey as jest.Mock).mockResolvedValue('old-pubkey-hex');
    (getNostrUserHandle as jest.Mock).mockResolvedValue('@alice');

    const mockBunker = {
      getPublicKey: jest.fn().mockResolvedValue('new-pubkey-hex'),
      signEvent: jest.fn().mockResolvedValue({ kind: 22242, sig: 'fake-sig' }),
    };
    (BunkerSigner.fromBunker as jest.Mock).mockReturnValue(mockBunker);
    handshakeSucceeds();
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

    // alice's handle must not bleed onto the new identity.
    expect(result?.userHandle).not.toBe('@alice');
    expect(setNostrUserHandle).toHaveBeenCalledWith('');
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
      'nostr+connect://test?secret=s3cr3t',
      ['wss://relay.test.com'],
      mockPool,
      mockContext,
      mockPanel,
      undefined, // revealQr
      0 // settleMs: skip the relay-settle delay in unit tests
    );

    expect(result).toBeDefined();
    // Malformed profile == no usable name: render the pubkey, and don't pass it
    // off as a handle by prefixing "@".
    expect(result?.userHandle).toBe('pubkey12…2345');
    expect(result?.userHandle).not.toMatch(/^@/);
  });

  it('returns undefined on error', async () => {
    handshakeFails(new Error('Connection refused'));

    const result = await resolveNostrInfoFromBunkerSigner(
      new Uint8Array(32),
      'nostr+connect://test?secret=s3cr3t',
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
      'nostr+connect://test?secret=s3cr3t',
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
      'nostr+connect://test?secret=s3cr3t',
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

// ── F4: per-money-call nonce-bound write credential ─────────────────────────
describe('signMoneyAuthEvent', () => {
  const CLIENT_SECRET_HEX = 'ab'.repeat(32);
  const BUNKER_POINTER = {
    pubkey: 'remote-signer-pubkey',
    relays: ['wss://relay.test.com'],
    secret: 'connect-secret',
  };

  beforeEach(() => {
    (getNostrClientSecret as jest.Mock).mockReset().mockResolvedValue(CLIENT_SECRET_HEX);
    (getNostrBunkerPointer as jest.Mock)
      .mockReset()
      .mockResolvedValue(JSON.stringify(BUNKER_POINTER));
    (BunkerSigner.fromBunker as jest.Mock).mockReset();
    sharedPool.close.mockReset();
    // Default: run the progress task immediately (matches the global mock).
    (vscode.window.withProgress as jest.Mock)
      .mockReset()
      .mockImplementation((_opts: any, task: any) =>
        task(
          { report: jest.fn() },
          { isCancellationRequested: false, onCancellationRequested: jest.fn() }
        )
      );
  });

  it('shows no "waiting on signer" notice when the signer answers promptly', async () => {
    (BunkerSigner.fromBunker as jest.Mock).mockReturnValue({
      signEvent: jest.fn().mockResolvedValue({ kind: 22242, sig: 'fast' }),
    });

    await signMoneyAuthEvent('server-nonce-abc');

    // Happy path settles well under the 6s grace window — no toast flashed.
    expect(vscode.window.withProgress).not.toHaveBeenCalled();
  });

  it('surfaces a self-dismissing "waiting on signer" notice when the request runs long', async () => {
    jest.useFakeTimers();
    try {
      // Capture the progress task so we can observe when the notice dismisses.
      let taskPromise: Promise<unknown> | undefined;
      (vscode.window.withProgress as jest.Mock).mockImplementation((_opts: any, task: any) => {
        taskPromise = Promise.resolve(
          task(
            { report: jest.fn() },
            { isCancellationRequested: false, onCancellationRequested: jest.fn() }
          )
        );
        return taskPromise;
      });

      // Signer answers only after the 5s notice threshold, before the 15s timeout.
      let resolveSign!: (v: unknown) => void;
      (BunkerSigner.fromBunker as jest.Mock).mockReturnValue({
        signEvent: jest.fn().mockReturnValue(new Promise((r) => { resolveSign = r; })),
      });

      const pending = signMoneyAuthEvent('server-nonce-abc', 'payout approval');

      // Cross the notice threshold — the progress notice appears.
      await jest.advanceTimersByTimeAsync(5500);
      expect(vscode.window.withProgress).toHaveBeenCalledTimes(1);
      const [opts] = (vscode.window.withProgress as jest.Mock).mock.calls[0];
      expect(opts.location).toBe(vscode.ProgressLocation.Notification);
      expect(opts.title).toMatch(/Waiting for your Nostr signer/i);
      // Notice carries the per-operation label and offers a Cancel button.
      expect(opts.title).toContain('payout approval');
      expect(opts.cancellable).toBe(true);

      // The notice stays up (task promise pending) until the request settles…
      let noticeCleared = false;
      void taskPromise!.then(() => { noticeCleared = true; });
      await Promise.resolve();
      expect(noticeCleared).toBe(false);

      // …now the signer answers → notice dismisses, call resolves.
      resolveSign({ kind: 22242, sig: 'late' });
      await jest.advanceTimersByTimeAsync(0);
      await pending;
      await Promise.resolve();
      expect(noticeCleared).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('times out (instead of hanging) when the signer never answers', async () => {
    jest.useFakeTimers();
    try {
      // A signer that never replies — the exact "Approve did nothing, no
      // error, no payout" case: signEvent had no timeout of its own.
      (BunkerSigner.fromBunker as jest.Mock).mockReturnValue({
        signEvent: jest.fn().mockReturnValue(new Promise(() => {})),
      });

      const pending = signMoneyAuthEvent('server-nonce-abc');
      const assertion = expect(pending).rejects.toThrow(/signer didn't respond/);
      // Write ops now use the 15s budget, not the old 60s one.
      await jest.advanceTimersByTimeAsync(16000);
      await assertion;

      // The pool is still torn down on the timeout path.
      expect(sharedPool.close).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('signs a write-scope event carrying the nonce, then closes the pool', async () => {
    const signedEvent = { kind: 22242, content: 'sattest-auth:write', sig: 'fake-sig' };
    const signEvent = jest.fn().mockResolvedValue(signedEvent);
    (BunkerSigner.fromBunker as jest.Mock).mockReturnValue({ signEvent });

    const result = await signMoneyAuthEvent('server-nonce-abc');

    expect(result).toBe(signedEvent);
    expect(BunkerSigner.fromBunker).toHaveBeenCalledWith(
      expect.anything(),
      BUNKER_POINTER,
      expect.objectContaining({ pool: expect.anything() })
    );

    const signedArg = signEvent.mock.calls[0][0];
    expect(signedArg.kind).toBe(22242);
    expect(signedArg.content).toBe('sattest-auth:write');
    expect(signedArg.tags).toContainEqual(['nonce', 'server-nonce-abc']);
    expect(signedArg.tags).toContainEqual(['challenge', 'sattest-auth:write']);
    const relayTag = signedArg.tags.find((t: string[]) => t[0] === 'relay');
    expect(relayTag?.[1]).toMatch(/^https?:\/\//);

    // Pool is torn down after signing — this isn't a long-lived session.
    expect(sharedPool.close).toHaveBeenCalledWith(BUNKER_POINTER.relays);
  });

  it('closes the pool even when signing throws', async () => {
    (BunkerSigner.fromBunker as jest.Mock).mockReturnValue({
      signEvent: jest.fn().mockRejectedValue(new Error('signer rejected')),
    });

    await expect(signMoneyAuthEvent('n')).rejects.toThrow('signer rejected');
    expect(sharedPool.close).toHaveBeenCalledWith(BUNKER_POINTER.relays);
  });

  it('throws without signing when no client secret is stored', async () => {
    (getNostrClientSecret as jest.Mock).mockResolvedValue(undefined);

    await expect(signMoneyAuthEvent('n')).rejects.toThrow('Nostr authentication required');
    expect(BunkerSigner.fromBunker).not.toHaveBeenCalled();
  });

  it('throws without signing when no bunker pointer is persisted', async () => {
    (getNostrBunkerPointer as jest.Mock).mockResolvedValue(undefined);

    await expect(signMoneyAuthEvent('n')).rejects.toThrow('Nostr authentication required');
    expect(BunkerSigner.fromBunker).not.toHaveBeenCalled();
  });
});

describe('isPubkeyFallbackHandle', () => {
  const PUBKEY = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

  it('recognises the legacy stored fallback (with and without @)', () => {
    // What older builds persisted on a failed lookup.
    expect(isPubkeyFallbackHandle(`${PUBKEY.slice(0, 10)}...`, PUBKEY)).toBe(true);
    expect(isPubkeyFallbackHandle(`@${PUBKEY.slice(0, 10)}...`, PUBKEY)).toBe(true);
  });

  it('recognises the current display rendering and empty values', () => {
    expect(isPubkeyFallbackHandle('abcdef12…7890', PUBKEY)).toBe(true);
    expect(isPubkeyFallbackHandle('', PUBKEY)).toBe(true);
    expect(isPubkeyFallbackHandle('   ', PUBKEY)).toBe(true);
  });

  it('treats a real name as a real handle', () => {
    expect(isPubkeyFallbackHandle('@alice', PUBKEY)).toBe(false);
    expect(isPubkeyFallbackHandle('@alice@example.com', PUBKEY)).toBe(false);
    // A hex-looking name that is NOT a prefix of this pubkey is still a name.
    expect(isPubkeyFallbackHandle('@deadbeef', PUBKEY)).toBe(false);
  });
});

describe('refreshNostrHandleIfStale', () => {
  const PUBKEY = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
  let pool: any;

  beforeEach(() => {
    const { SimplePool } = require('nostr-tools');
    pool = new SimplePool();
    pool.get.mockReset().mockResolvedValue(null);
    const { getNostrRelays } = require('../state');
    (getNostrRelays as jest.Mock).mockReturnValue(['wss://relay.test.com']);
  });

  it('does nothing when no identity is connected', async () => {
    const { getNostrUserPubkey, setNostrUserHandle } = require('../state');
    (getNostrUserPubkey as jest.Mock).mockResolvedValue(undefined);

    await expect(refreshNostrHandleIfStale()).resolves.toBeUndefined();
    expect(setNostrUserHandle).not.toHaveBeenCalled();
    expect(pool.get).not.toHaveBeenCalled();
  });

  it('leaves an already-good handle alone (no relay round-trip)', async () => {
    const { getNostrUserPubkey, getNostrUserHandle, setNostrUserHandle } = require('../state');
    (getNostrUserPubkey as jest.Mock).mockResolvedValue(PUBKEY);
    (getNostrUserHandle as jest.Mock).mockResolvedValue('@alice');

    await expect(refreshNostrHandleIfStale()).resolves.toBeUndefined();
    expect(pool.get).not.toHaveBeenCalled();
    expect(setNostrUserHandle).not.toHaveBeenCalled();
  });

  it('re-resolves and stores the real name over a poisoned hex fallback', async () => {
    const { getNostrUserPubkey, getNostrUserHandle, setNostrUserHandle } = require('../state');
    (getNostrUserPubkey as jest.Mock).mockResolvedValue(PUBKEY);
    // Stored by an older build after a failed lookup.
    (getNostrUserHandle as jest.Mock).mockResolvedValue(`${PUBKEY.slice(0, 10)}...`);
    pool.get.mockResolvedValue({ content: JSON.stringify({ name: 'alice' }) });

    await expect(refreshNostrHandleIfStale()).resolves.toBe('@alice');
    expect(setNostrUserHandle).toHaveBeenCalledWith('@alice');
  });

  it('does not persist anything when the refresh lookup also misses', async () => {
    const { getNostrUserPubkey, getNostrUserHandle, setNostrUserHandle } = require('../state');
    (getNostrUserPubkey as jest.Mock).mockResolvedValue(PUBKEY);
    (getNostrUserHandle as jest.Mock).mockResolvedValue(`${PUBKEY.slice(0, 10)}...`);
    pool.get.mockResolvedValue(null);

    await expect(refreshNostrHandleIfStale()).resolves.toBeUndefined();
    expect(setNostrUserHandle).not.toHaveBeenCalled();
  });

  it('never throws when the relay read fails (activation must not break)', async () => {
    const { getNostrUserPubkey, getNostrUserHandle } = require('../state');
    (getNostrUserPubkey as jest.Mock).mockResolvedValue(PUBKEY);
    (getNostrUserHandle as jest.Mock).mockResolvedValue(undefined);
    pool.get.mockRejectedValue(new Error('relay down'));

    await expect(refreshNostrHandleIfStale()).resolves.toBeUndefined();
  });
});
