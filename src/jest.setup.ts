import * as vscode from 'vscode';

jest.mock('vscode', () => {
  const ViewColumn = {
    Active: -1,
    Beside: -2,
    One: 1,
    Two: 2,
    Three: 3,
  };

  const mockRange = jest.fn().mockImplementation((startLine, startChar, endLine, endChar) => ({
    start: { line: startLine, character: startChar },
    end: { line: endLine, character: endChar },
    contains: jest.fn(),
    intersection: jest.fn(),
    union: jest.fn(),
    isEqual: jest.fn(),
    isSingleLine: startLine === endLine,
  }));

  const mockUri = {
    file: jest.fn().mockImplementation((path) => ({
      fsPath: path,
      scheme: 'file',
      authority: null,
      path,
      query: '',
      fragment: '',
      with: jest.fn().mockReturnThis(),
      toString: jest.fn().mockReturnValue(`file://${path}`),
    })),
    parse: jest.fn().mockImplementation((uriString) => ({
      fsPath: uriString.replace('file://', ''),
      scheme: 'file',
    })),
  };

  const mockEventEmitter = jest.fn().mockImplementation(() => {
    const listeners: Array<(...args: any[]) => void> = [];
    return {
      event: jest.fn().mockImplementation((listener) => {
        listeners.push(listener);
        return { dispose: jest.fn() };
      }),
      fire: jest.fn().mockImplementation((...args) => {
        listeners.forEach((listener) => listener(...args));
      }),
      dispose: jest.fn(),
    };
  });

  const mockConfiguration = {
    get: jest.fn().mockReturnValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
  };

  const mockWorkspace = {
    workspaceFolders: [
      {
        uri: {
          fsPath: '/mock/workspace',
          scheme: 'file',
          path: '/mock/workspace',
          toString: () => 'file:///mock/workspace',
        },
      },
    ],
    findFiles: jest.fn().mockResolvedValue([]),
    fs: {
      readFile: jest.fn().mockResolvedValue(Buffer.from('')),
    },
    onDidOpenTextDocument: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    getConfiguration: jest.fn().mockReturnValue(mockConfiguration),
  };

  const testItemChildren = new Map();
  const mockTestController = {
    items: {
      _items: new Map(),
      get size() {
        return this._items.size;
      },
      forEach: jest.fn().mockImplementation(function (this: any, cb: any) {
        this._items.forEach((value: any, key: any) => cb(value, key));
      }),
      replace: jest.fn().mockImplementation(function (this: any, items: any[]) {
        this._items.clear();
        items.forEach((item: any) => this._items.set(item.id, item));
      }),
      add: jest.fn().mockImplementation(function (this: any, item: any) {
        this._items.set(item.id, item);
      }),
      get: jest.fn().mockImplementation(function (this: any, id: string) {
        return this._items.get(id);
      }),
      delete: jest.fn().mockImplementation(function (this: any, id: string) {
        this._items.delete(id);
      }),
    },
    createTestItem: jest.fn().mockImplementation((id, label, uri) => {
      const children = new Map();
      return {
        id,
        label,
        uri,
        range: undefined,
        children: {
          _items: children,
          forEach: jest.fn().mockImplementation((cb: any) => {
            children.forEach((value: any, key: any) => cb(value, key));
          }),
          add: jest.fn().mockImplementation((item: any) => {
            children.set(item.id, item);
          }),
          get size() {
            return children.size;
          },
        },
      };
    }),
    dispose: jest.fn(),
  };

  return {
    ViewColumn,
    workspace: mockWorkspace,
    EventEmitter: mockEventEmitter,
    Uri: mockUri,
    Range: mockRange,
    ConfigurationTarget: {
      Global: 1,
      Workspace: 2,
      WorkspaceFolder: 3,
    },
    tests: {
      createTestController: jest.fn().mockReturnValue(mockTestController),
    },
    window: {
      showInformationMessage: jest.fn().mockResolvedValue(undefined),
      showInputBox: jest.fn().mockResolvedValue(undefined),
      showQuickPick: jest.fn().mockResolvedValue(undefined),
      showErrorMessage: jest.fn().mockResolvedValue(undefined),
      showWarningMessage: jest.fn().mockResolvedValue(undefined),
      visibleTextEditors: [],
      onDidChangeActiveTextEditor: jest.fn().mockReturnValue({ dispose: jest.fn() }),
      createWebviewPanel: jest.fn().mockImplementation((viewType, title, viewColumn, options) => {
        return {
          webview: {
            html: '',
            postMessage: jest.fn(),
            asWebviewUri: jest.fn((uri: any) => uri),
            onDidReceiveMessage: jest.fn().mockReturnValue({ dispose: jest.fn() }),
          },
          title,
          viewColumn,
          dispose: jest.fn(),
          onDidDispose: jest.fn().mockImplementation((cb: any) => {
            // Store dispose callback for testing
            return { dispose: jest.fn() };
          }),
          onDidChangeViewState: jest.fn(),
        };
      }),
    },
    commands: {
      registerCommand: jest.fn(),
      executeCommand: jest.fn().mockResolvedValue(undefined),
    },
    languages: {
      registerCodeLensProvider: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    },
    TestRunProfileKind: {
      Run: 1,
      Debug: 2,
      Coverage: 3,
    },
    CodeLens: jest.fn().mockImplementation((range: any, command: any) => ({
      range,
      command,
      isResolved: !!command,
    })),
    CancellationTokenSource: jest.fn().mockImplementation(() => ({
      token: { isCancellationRequested: false, onCancellationRequested: jest.fn() },
      cancel: jest.fn(),
      dispose: jest.fn(),
    })),
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  (vscode.window.showInformationMessage as jest.Mock).mockReset();
  (vscode.window.showInputBox as jest.Mock).mockReset();
  (vscode.window.showErrorMessage as jest.Mock).mockReset();
  (vscode.window.showWarningMessage as jest.Mock).mockReset();
  jest.spyOn(global, 'fetch').mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});
