import * as vscode from 'vscode';
import { activate, deactivate } from './extension.js';
import { initializeSecrets } from './state.js';
import { fetchBounties } from './api/bounty.api.js';
import { connectNostr } from './api/nostr.api.js';
import { activateTestController, myTestController } from './test/test-controller.js';
import { findTestItemById, getRepoSlug, getLocalTestIds } from './test/test-item.util.js';

jest.mock('./api/bounty.api', () => ({
  fetchBounties: jest.fn().mockResolvedValue([]),
}));

jest.mock('./api/nostr.api', () => ({
  connectNostr: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./api/nwc.api', () => ({
  setNwcUri: jest.fn().mockResolvedValue('ok'),
  clearNwcUri: jest.fn().mockResolvedValue(true),
  getNwcStatus: jest.fn().mockResolvedValue({ configured: false }),
}));

jest.mock('./api/authed-fetch', () => ({
  setAuthRefresher: jest.fn(),
}));

jest.mock('./state', () => ({
  initializeSecrets: jest.fn(),
  getNostrUserPubkey: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./test/test-controller', () => {
  const items = new Map();
  return {
    activateTestController: jest.fn(),
    myTestController: {
      items: {
        _items: items,
        get size() {
          return items.size;
        },
        forEach: jest.fn(),
        replace: jest.fn(),
        add: jest.fn(),
      },
    },
  };
});

jest.mock('./test/test-item.util', () => ({
  findTestItemById: jest.fn().mockReturnValue({
    id: 'test-1',
    label: 'test',
    children: [],
  }),
  getRepoSlug: jest.fn().mockReturnValue('owner/repo'),
  getLocalTestIds: jest.fn().mockReturnValue([]),
  workspaceRoot: jest.fn().mockReturnValue('/mock/workspace'),
}));

function createMockContext(): vscode.ExtensionContext {
  return {
    globalState: {
      get: jest.fn().mockReturnValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      keys: jest.fn().mockReturnValue([]),
      setKeysForSync: jest.fn(),
    },
    secrets: {
      get: jest.fn().mockResolvedValue(undefined),
      store: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    subscriptions: [],
    extensionPath: '',
    asAbsolutePath: jest.fn((path: string) => path),
    storagePath: '',
    globalStoragePath: '',
    logPath: '',
  } as unknown as vscode.ExtensionContext;
}

describe('extension', () => {
  describe('activate', () => {
    it('initializes secrets with context', async () => {
      const context = createMockContext();
      await activate(context);
      expect(initializeSecrets).toHaveBeenCalledWith(context);
    });

    it('activates test controller', async () => {
      const context = createMockContext();
      await activate(context);
      expect(activateTestController).toHaveBeenCalledWith(context);
    });

    it('fetches bounties on startup', async () => {
      const context = createMockContext();
      await activate(context);
      expect(fetchBounties).toHaveBeenCalled();
    });

    it('registers connectNostr command that calls connectNostr', async () => {
      const context = createMockContext();
      let connectHandler: Function | undefined;

      (vscode.commands.registerCommand as jest.Mock).mockImplementation(
        (id: string, handler: Function) => {
          if (id === 'sattest.connectNostr') {
            connectHandler = handler;
          }
          return { dispose: jest.fn() };
        }
      );

      await activate(context);

      expect(connectHandler).toBeDefined();
      await connectHandler!();
      expect(connectNostr).toHaveBeenCalledWith(context, expect.anything());
    });

    it('registers an auth refresher that reconnects Nostr on a 401', async () => {
      const { setAuthRefresher } = require('./api/authed-fetch');
      (setAuthRefresher as jest.Mock).mockClear();
      (connectNostr as jest.Mock).mockClear().mockResolvedValue({ userPubkey: 'pk', userHandle: '@me' });

      await activate(createMockContext());

      // The API layer was handed a refresher at activation.
      expect(setAuthRefresher).toHaveBeenCalledWith(expect.any(Function));
      const refresher = (setAuthRefresher as jest.Mock).mock.calls.at(-1)![0] as () => Promise<boolean>;

      // Invoking it reconnects Nostr (with the session-expired notice) and
      // resolves truthy so authedFetch knows to retry.
      const ok = await refresher();
      expect(ok).toBe(true);
      expect(connectNostr).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ noticeMessage: expect.stringContaining('session expired') })
      );
    });

    it('refreshes the code-lens pubkey after a late Nostr connect', async () => {
      // Simulate: user connects to Nostr after activation. The cached pubkey
      // at activate() time was undefined; calling getNostrUserPubkey() again
      // after connectNostr resolves returns the freshly-paired pubkey.
      const { getNostrUserPubkey } = require('./state');
      (getNostrUserPubkey as jest.Mock)
        .mockResolvedValueOnce(undefined) // activation read
        .mockResolvedValueOnce('newly-paired-npub'); // post-connect read

      let connectHandler: Function | undefined;
      (vscode.commands.registerCommand as jest.Mock).mockImplementation(
        (id: string, handler: Function) => {
          if (id === 'sattest.connectNostr') {
            connectHandler = handler;
          }
          return { dispose: jest.fn() };
        }
      );

      // Capture the BountyCodeLensProvider instance that activate() constructs.
      const codeLensModule = require('./bounty/bounty-code-lens');
      const setSpy = jest.fn();
      const ctorSpy = jest
        .spyOn(codeLensModule, 'BountyCodeLensProvider')
        .mockImplementation(() => ({
          _onDidChangeCodeLenses: { fire: jest.fn(), event: jest.fn() },
          onDidChangeCodeLenses: jest.fn(),
          setUserNostrPubkey: setSpy,
          provideCodeLenses: jest.fn().mockReturnValue([]),
        }));

      try {
        await activate(createMockContext());
        await connectHandler!();
        expect(setSpy).toHaveBeenCalledWith('newly-paired-npub');
      } finally {
        ctorSpy.mockRestore();
      }
    });

    it('registers CodeLens provider for TypeScript and JavaScript', async () => {
      const context = createMockContext();
      await activate(context);

      expect(vscode.languages.registerCodeLensProvider).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ language: 'typescript' }),
          expect.objectContaining({ language: 'javascript' }),
        ]),
        expect.anything()
      );
    });

    it('adds disposables to subscriptions', async () => {
      const context = createMockContext();
      await activate(context);
      expect(context.subscriptions.length).toBeGreaterThan(0);
    });

    it('handles fetch bounties failure gracefully', async () => {
      (fetchBounties as jest.Mock).mockRejectedValueOnce(new Error('Network error'));
      const context = createMockContext();
      await activate(context);
    });

    it('refreshes CodeLens for visible typescript editors', async () => {
      (vscode.window as any).visibleTextEditors = [
        { document: { languageId: 'typescript' } },
        { document: { languageId: 'python' } },
      ];

      const context = createMockContext();
      await activate(context);

      (vscode.window as any).visibleTextEditors = [];
    });

    it('registers onDidChangeActiveTextEditor callback', async () => {
      const context = createMockContext();
      await activate(context);
      expect(vscode.window.onDidChangeActiveTextEditor).toHaveBeenCalled();
    });

    it('editor change callback fetches bounties for ts files', async () => {
      let editorChangeCallback: Function | undefined;
      (vscode.window.onDidChangeActiveTextEditor as jest.Mock).mockImplementation(
        (cb: Function) => {
          editorChangeCallback = cb;
          return { dispose: jest.fn() };
        }
      );

      const context = createMockContext();
      await activate(context);
      expect(editorChangeCallback).toBeDefined();

      (fetchBounties as jest.Mock).mockResolvedValue([{ testId: '/test-1', amountSats: 1000 }]);

      editorChangeCallback!({
        document: { languageId: 'typescript' },
      });

      // Let the .then() chain resolve
      await new Promise((resolve) => process.nextTick(resolve));
      await new Promise((resolve) => process.nextTick(resolve));
    });

    it('editor change callback handles fetch error', async () => {
      let editorChangeCallback: Function | undefined;
      (vscode.window.onDidChangeActiveTextEditor as jest.Mock).mockImplementation(
        (cb: Function) => {
          editorChangeCallback = cb;
          return { dispose: jest.fn() };
        }
      );

      const context = createMockContext();
      await activate(context);

      (fetchBounties as jest.Mock).mockRejectedValue(new Error('fail'));

      editorChangeCallback!({
        document: { languageId: 'javascript' },
      });

      await new Promise((resolve) => process.nextTick(resolve));
      await new Promise((resolve) => process.nextTick(resolve));
    });

    it('editor change callback ignores non-ts/js editors', async () => {
      let editorChangeCallback: Function | undefined;
      (vscode.window.onDidChangeActiveTextEditor as jest.Mock).mockImplementation(
        (cb: Function) => {
          editorChangeCallback = cb;
          return { dispose: jest.fn() };
        }
      );

      const context = createMockContext();
      await activate(context);

      (fetchBounties as jest.Mock).mockClear();
      editorChangeCallback!({ document: { languageId: 'markdown' } });
      expect(fetchBounties).not.toHaveBeenCalled();
    });

    it('editor change callback ignores undefined editor', async () => {
      let editorChangeCallback: Function | undefined;
      (vscode.window.onDidChangeActiveTextEditor as jest.Mock).mockImplementation(
        (cb: Function) => {
          editorChangeCallback = cb;
          return { dispose: jest.fn() };
        }
      );

      const context = createMockContext();
      await activate(context);

      (fetchBounties as jest.Mock).mockClear();
      editorChangeCallback!(undefined);
      expect(fetchBounties).not.toHaveBeenCalled();
    });

    it('sets up polling interval for test controller items', async () => {
      jest.useFakeTimers();
      try {
        const context = createMockContext();
        await activate(context);

        (myTestController.items as any)._items.set('test-1', { id: 'test-1' });
        jest.advanceTimersByTime(2000);
      } finally {
        jest.useRealTimers();
      }
    });

    it('polling stops after 30 seconds', async () => {
      jest.useFakeTimers();
      try {
        const context = createMockContext();
        await activate(context);
        jest.advanceTimersByTime(31000);
      } finally {
        jest.useRealTimers();
      }
    });

    it('attaches test items from backend bounties', async () => {
      (fetchBounties as jest.Mock).mockResolvedValue([
        { testId: '/test-1', amountSats: 1000 },
        { testId: '/test-2', amountSats: 2000 },
      ]);

      const context = createMockContext();
      await activate(context);

      expect(findTestItemById).toHaveBeenCalledWith('/test-1');
      expect(findTestItemById).toHaveBeenCalledWith('/test-2');
    });

    it('handles missing test item in attachTestItems', async () => {
      (findTestItemById as jest.Mock).mockReturnValue(undefined);
      (fetchBounties as jest.Mock).mockResolvedValue([
        { testId: '/missing-test', amountSats: 1000 },
      ]);

      const context = createMockContext();
      await activate(context);
    });
  });

  describe('connectWallet command', () => {
    async function captureHandler(commandId: string): Promise<Function> {
      let captured: Function | undefined;
      (vscode.commands.registerCommand as jest.Mock).mockImplementation(
        (id: string, handler: Function) => {
          if (id === commandId) {
            captured = handler;
          }
          return { dispose: jest.fn() };
        }
      );
      await activate(createMockContext());
      if (!captured){
        throw new Error(`${commandId} not registered`);
      }
      return captured;
    }

    beforeEach(() => {
      const { setNwcUri, getNwcStatus } = require('./api/nwc.api');
      (setNwcUri as jest.Mock).mockClear().mockResolvedValue('ok');
      (getNwcStatus as jest.Mock).mockClear();
      const { connectNostr } = require('./api/nostr.api');
      (connectNostr as jest.Mock).mockClear().mockResolvedValue(undefined);
      const { getNostrUserPubkey } = require('./state');
      (getNostrUserPubkey as jest.Mock).mockReset().mockResolvedValue(undefined);
      (vscode.window.showInputBox as jest.Mock).mockReset();
      (vscode.window.showQuickPick as jest.Mock | undefined)?.mockReset?.();
      (vscode.window.showInformationMessage as jest.Mock).mockClear();
      (vscode.window.showErrorMessage as jest.Mock).mockClear();
      (vscode.window.showWarningMessage as jest.Mock).mockClear();
    });

    it('errors out when Nostr is not connected', async () => {
      const handler = await captureHandler('sattest.connectWallet');
      await handler();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Connect to Nostr first')
      );
      const { setNwcUri } = require('./api/nwc.api');
      expect(setNwcUri).not.toHaveBeenCalled();
    });

    it('returns silently when user cancels the URI prompt', async () => {
      const { getNostrUserPubkey } = require('./state');
      (getNostrUserPubkey as jest.Mock).mockResolvedValue('npub-pub');
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue(undefined);

      const handler = await captureHandler('sattest.connectWallet');
      await handler();

      const { setNwcUri } = require('./api/nwc.api');
      expect(setNwcUri).not.toHaveBeenCalled();
    });

    it('returns silently when user dismisses the budget-window quick-pick', async () => {
      const { getNostrUserPubkey } = require('./state');
      (getNostrUserPubkey as jest.Mock).mockResolvedValue('npub-pub');
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('nostr+walletconnect://abc');
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

      const handler = await captureHandler('sattest.connectWallet');
      await handler();

      const { setNwcUri } = require('./api/nwc.api');
      expect(setNwcUri).not.toHaveBeenCalled();
    });

    it('connects with no budget when user picks "Skip"', async () => {
      const { getNostrUserPubkey } = require('./state');
      (getNostrUserPubkey as jest.Mock).mockResolvedValue('npub-pub');
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('  nostr+walletconnect://abc  ');
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
        label: 'Skip',
        value: undefined,
      });

      const handler = await captureHandler('sattest.connectWallet');
      await handler();

      const { setNwcUri } = require('./api/nwc.api');
      expect(setNwcUri).toHaveBeenCalledWith('nostr+walletconnect://abc', undefined, undefined);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('connected')
      );
    });

    it('connects with budget sats when user provides them', async () => {
      const { getNostrUserPubkey } = require('./state');
      (getNostrUserPubkey as jest.Mock).mockResolvedValue('npub-pub');
      (vscode.window.showInputBox as jest.Mock)
        .mockResolvedValueOnce('nostr+walletconnect://abc') // URI
        .mockResolvedValueOnce('  100000  '); // budget sats
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
        label: 'Daily',
        value: 'daily',
      });

      const handler = await captureHandler('sattest.connectWallet');
      await handler();

      const { setNwcUri } = require('./api/nwc.api');
      expect(setNwcUri).toHaveBeenCalledWith('nostr+walletconnect://abc', 100000, 'daily');
    });

    it('connects without budget when user leaves sats blank', async () => {
      const { getNostrUserPubkey } = require('./state');
      (getNostrUserPubkey as jest.Mock).mockResolvedValue('npub-pub');
      (vscode.window.showInputBox as jest.Mock)
        .mockResolvedValueOnce('nostr+walletconnect://abc')
        .mockResolvedValueOnce(''); // empty budget
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
        label: 'Weekly',
        value: 'weekly',
      });

      const handler = await captureHandler('sattest.connectWallet');
      await handler();

      const { setNwcUri } = require('./api/nwc.api');
      expect(setNwcUri).toHaveBeenCalledWith(
        'nostr+walletconnect://abc',
        undefined,
        'weekly'
      );
    });

    it('skips success toast when setNwcUri returns "failed"', async () => {
      const { getNostrUserPubkey } = require('./state');
      (getNostrUserPubkey as jest.Mock).mockResolvedValue('npub-pub');
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('nostr+walletconnect://abc');
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
        label: 'Skip',
        value: undefined,
      });
      const { setNwcUri } = require('./api/nwc.api');
      (setNwcUri as jest.Mock).mockResolvedValueOnce('failed');

      const handler = await captureHandler('sattest.connectWallet');
      await handler();

      // setNwcUri itself surfaces the error toast — extension stays quiet.
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(
        expect.stringContaining('connected')
      );
    });

    it('on auth-expired: reopens Connect to Nostr, then retries and succeeds', async () => {
      const { getNostrUserPubkey } = require('./state');
      (getNostrUserPubkey as jest.Mock).mockResolvedValue('npub-pub');
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('nostr+walletconnect://abc');
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ label: 'Skip', value: undefined });

      const { setNwcUri } = require('./api/nwc.api');
      // First attempt: stale auth. After reconnect: success.
      (setNwcUri as jest.Mock).mockResolvedValueOnce('auth-expired').mockResolvedValueOnce('ok');
      const { connectNostr } = require('./api/nostr.api');
      (connectNostr as jest.Mock).mockResolvedValue({ userPubkey: 'pk', userHandle: '@me' });

      const handler = await captureHandler('sattest.connectWallet');
      await handler();

      // Connect to Nostr reopened with the refresh-login notice.
      expect(connectNostr).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          noticeMessage: expect.stringContaining('Refresh your Nostr login'),
        })
      );
      // Retried once (2 calls total) and then succeeded.
      expect(setNwcUri).toHaveBeenCalledTimes(2);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('connected')
      );
    });

    it('on auth-expired: if the user dismisses the reconnect, warns and does not retry', async () => {
      const { getNostrUserPubkey } = require('./state');
      (getNostrUserPubkey as jest.Mock).mockResolvedValue('npub-pub');
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('nostr+walletconnect://abc');
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ label: 'Skip', value: undefined });

      const { setNwcUri } = require('./api/nwc.api');
      (setNwcUri as jest.Mock).mockResolvedValue('auth-expired');
      const { connectNostr } = require('./api/nostr.api');
      (connectNostr as jest.Mock).mockResolvedValue(undefined); // user bailed

      const handler = await captureHandler('sattest.connectWallet');
      await handler();

      expect(connectNostr).toHaveBeenCalled();
      // No retry — only the initial attempt.
      expect(setNwcUri).toHaveBeenCalledTimes(1);
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('refresh your Nostr login')
      );
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(
        expect.stringContaining('connected')
      );
    });

    it('on success first try: does not reopen Connect to Nostr', async () => {
      const { getNostrUserPubkey } = require('./state');
      (getNostrUserPubkey as jest.Mock).mockResolvedValue('npub-pub');
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('nostr+walletconnect://abc');
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ label: 'Skip', value: undefined });

      const { setNwcUri } = require('./api/nwc.api');
      (setNwcUri as jest.Mock).mockResolvedValue('ok');
      const { connectNostr } = require('./api/nostr.api');

      const handler = await captureHandler('sattest.connectWallet');
      await handler();

      expect(connectNostr).not.toHaveBeenCalled();
      expect(setNwcUri).toHaveBeenCalledTimes(1);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('connected')
      );
    });

    describe('URI validateInput', () => {
      it('rejects strings missing the nostr+walletconnect:// scheme', async () => {
        const { getNostrUserPubkey } = require('./state');
        (getNostrUserPubkey as jest.Mock).mockResolvedValue('npub-pub');
        (vscode.window.showInputBox as jest.Mock).mockResolvedValue(undefined);

        const handler = await captureHandler('sattest.connectWallet');
        await handler();

        const opts = (vscode.window.showInputBox as jest.Mock).mock.calls[0][0];
        expect(opts.validateInput('https://example.com')).toMatch(/Expected/);
        expect(opts.validateInput('  nostr+walletconnect://x  ')).toBeNull();
      });
    });

    describe('budget sats validateInput', () => {
      it('accepts blank, accepts positive ints, rejects others', async () => {
        const { getNostrUserPubkey } = require('./state');
        (getNostrUserPubkey as jest.Mock).mockResolvedValue('npub-pub');
        (vscode.window.showInputBox as jest.Mock)
          .mockResolvedValueOnce('nostr+walletconnect://abc')
          .mockResolvedValueOnce(undefined);
        (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
          label: 'Daily',
          value: 'daily',
        });

        const handler = await captureHandler('sattest.connectWallet');
        await handler();

        const opts = (vscode.window.showInputBox as jest.Mock).mock.calls[1][0];
        expect(opts.validateInput('')).toBeNull();
        expect(opts.validateInput('  ')).toBeNull();
        expect(opts.validateInput('1000')).toBeNull();
        expect(opts.validateInput('0')).toMatch(/positive/);
        expect(opts.validateInput('-5')).toMatch(/positive/);
        expect(opts.validateInput('abc')).toMatch(/positive/);
      });
    });
  });

  describe('disconnectWallet command', () => {
    async function captureHandler(commandId: string): Promise<Function> {
      let captured: Function | undefined;
      (vscode.commands.registerCommand as jest.Mock).mockImplementation(
        (id: string, handler: Function) => {
          if (id === commandId) {
            captured = handler;
          }
          return { dispose: jest.fn() };
        }
      );
      await activate(createMockContext());
      if (!captured) {
        throw new Error(`${commandId} not registered`);
      }
      return captured;
    }

    beforeEach(() => {
      const { clearNwcUri, getNwcStatus } = require('./api/nwc.api');
      (clearNwcUri as jest.Mock).mockClear().mockResolvedValue(true);
      (getNwcStatus as jest.Mock).mockClear();
      (vscode.window.showWarningMessage as jest.Mock).mockReset();
      (vscode.window.showInformationMessage as jest.Mock).mockClear();
    });

    it('no-ops when no wallet is configured', async () => {
      const { getNwcStatus, clearNwcUri } = require('./api/nwc.api');
      (getNwcStatus as jest.Mock).mockResolvedValue({ configured: false });

      const handler = await captureHandler('sattest.disconnectWallet');
      await handler();

      expect(clearNwcUri).not.toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('No Lightning wallet')
      );
    });

    it('aborts when user cancels the confirmation', async () => {
      const { getNwcStatus, clearNwcUri } = require('./api/nwc.api');
      (getNwcStatus as jest.Mock).mockResolvedValue({ configured: true });
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

      const handler = await captureHandler('sattest.disconnectWallet');
      await handler();

      expect(clearNwcUri).not.toHaveBeenCalled();
    });

    it('disconnects and toasts on success', async () => {
      const { getNwcStatus, clearNwcUri } = require('./api/nwc.api');
      (getNwcStatus as jest.Mock).mockResolvedValue({ configured: true });
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Disconnect');

      const handler = await captureHandler('sattest.disconnectWallet');
      await handler();

      expect(clearNwcUri).toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('disconnected')
      );
    });

    it('skips success toast when clearNwcUri returns false', async () => {
      const { getNwcStatus, clearNwcUri } = require('./api/nwc.api');
      (getNwcStatus as jest.Mock).mockResolvedValue({ configured: true });
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Disconnect');
      (clearNwcUri as jest.Mock).mockResolvedValueOnce(false);

      const handler = await captureHandler('sattest.disconnectWallet');
      await handler();

      expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(
        expect.stringContaining('disconnected')
      );
    });
  });

  describe('deactivate', () => {
    it('returns without error', () => {
      expect(() => deactivate()).not.toThrow();
    });
  });
});
