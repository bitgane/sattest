export const window = {
  showInputBox: jest.fn(),
  showInformationMessage: jest.fn(),
  showWarningMessage: jest.fn(),
  showErrorMessage: jest.fn(),
  createWebviewPanel: jest.fn().mockReturnValue({ webview: { html: '' } }),
};

export const commands = {
  registerCommand: jest.fn().mockImplementation((id, callback) => ({ id, callback })),
  executeCommand: jest.fn(),
};

const globalStateMap = new Map();
export const globalState = {
  get: jest.fn((key) => globalStateMap.get(key)),
  update: jest.fn((key, value) => {
    globalStateMap.set(key, value);
    return Promise.resolve();
  }),
};

const secretsMap = new Map();
export const secrets = {
  get: jest.fn((key) => Promise.resolve(secretsMap.get(key))),
  store: jest.fn((key, value) => {
    secretsMap.set(key, value);
    return Promise.resolve();
  }),
};

export const Uri = {
  file: (path: string) => ({ fsPath: path, toString: () => `file://${path}` }),
};

export const Range = jest.fn();

export const EventEmitter = jest.fn().mockImplementation(() => ({
  event: jest.fn(),
  fire: jest.fn(),
  dispose: jest.fn(),
}));

// Add TestItem, CancellationToken, etc. as needed
export const TestItem = jest.fn();
