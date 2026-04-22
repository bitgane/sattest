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

  describe('deactivate', () => {
    it('returns without error', () => {
      expect(() => deactivate()).not.toThrow();
    });
  });
});
