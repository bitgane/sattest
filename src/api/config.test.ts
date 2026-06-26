import * as vscode from 'vscode';
import { getBackendUrl, getApiKey, getApiHeaders } from './config.js';

describe('getBackendUrl', () => {
  /** Mock getConfiguration().inspect() to return the given inspect result. */
  function mockInspect(result: Record<string, unknown> | undefined) {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn(),
      update: jest.fn(),
      inspect: jest.fn().mockReturnValue(result),
    });
  }

  it('returns the user (global) configured URL', () => {
    mockInspect({ globalValue: 'https://api.sattest.io' });
    expect(getBackendUrl()).toBe('https://api.sattest.io');
  });

  it('falls back to the built-in default when no user value is set', () => {
    mockInspect({ defaultValue: 'https://default.sattest.io' });
    expect(getBackendUrl()).toBe('https://default.sattest.io');
  });

  it('falls back to localhost when inspect returns nothing', () => {
    mockInspect(undefined);
    expect(getBackendUrl()).toBe('http://localhost:3000');
  });

  it('strips trailing slashes', () => {
    mockInspect({ globalValue: 'https://api.sattest.io///' });
    expect(getBackendUrl()).toBe('https://api.sattest.io');
  });

  // Security: a workspace must not be able to redirect the backend (it carries
  // the Nostr auth credential + NWC spending grant). Workspace/folder values
  // are ignored; only the user value or default is honored.
  it('IGNORES a workspace-provided value, using the user value instead', () => {
    mockInspect({
      globalValue: 'https://real.sattest.io',
      workspaceValue: 'https://evil.example.com',
      workspaceFolderValue: 'https://evil.example.com',
    });
    expect(getBackendUrl()).toBe('https://real.sattest.io');
  });

  it('IGNORES a workspace-provided value, falling back to the default', () => {
    mockInspect({
      defaultValue: 'https://default.sattest.io',
      workspaceValue: 'https://evil.example.com',
    });
    expect(getBackendUrl()).toBe('https://default.sattest.io');
  });

  it('allows http only for localhost', () => {
    mockInspect({ globalValue: 'http://localhost:3000' });
    expect(getBackendUrl()).toBe('http://localhost:3000');
    mockInspect({ globalValue: 'http://127.0.0.1:3000' });
    expect(getBackendUrl()).toBe('http://127.0.0.1:3000');
  });

  it('throws on a plaintext http:// non-localhost URL (fail closed)', () => {
    mockInspect({ globalValue: 'http://evil.example.com' });
    expect(() => getBackendUrl()).toThrow(/only https/);
  });

  it('throws on a non-http(s) scheme', () => {
    mockInspect({ globalValue: 'file:///etc/passwd' });
    expect(() => getBackendUrl()).toThrow(/only https/);
  });
});

describe('getApiKey', () => {
  it('returns API key from settings', async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'apiKey') {
          return 'settings-key-123';
        }
        return undefined;
      }),
      update: jest.fn(),
    });
    const key = await getApiKey();
    expect(key).toBe('settings-key-123');
  });

  it('uses cached key on second call (returns same key)', async () => {
    // After the first call above cached the key, subsequent calls should return it
    // even if getConfiguration returns something different
    const key = await getApiKey();
    expect(key).toBe('settings-key-123');
  });

  it('prompts user when no settings key and saves to config', async () => {
    // We need a fresh module to test the prompt path since cache persists
    jest.resetModules();
    const freshVscode = require('vscode');
    const freshConfig = require('./config');

    const mockUpdate = jest.fn().mockResolvedValue(undefined);
    freshVscode.workspace.getConfiguration.mockReturnValue({
      get: jest.fn().mockReturnValue(undefined),
      update: mockUpdate,
    });
    freshVscode.window.showInputBox.mockResolvedValue('user-input-key');

    const key = await freshConfig.getApiKey();
    expect(key).toBe('user-input-key');
    expect(freshVscode.window.showInputBox).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Enter your Sattest API key',
        password: true,
      })
    );
    expect(mockUpdate).toHaveBeenCalledWith('apiKey', 'user-input-key', 1);
  });

  it('throws when user cancels prompt', async () => {
    jest.resetModules();
    const freshVscode = require('vscode');
    const freshConfig = require('./config');

    freshVscode.workspace.getConfiguration.mockReturnValue({
      get: jest.fn().mockReturnValue(undefined),
      update: jest.fn(),
    });
    freshVscode.window.showInputBox.mockResolvedValue(undefined);

    await expect(freshConfig.getApiKey()).rejects.toThrow('API key is required');
  });
});

describe('getApiHeaders', () => {
  it('returns headers with X-API-Key', async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'apiKey') {
          return 'my-key';
        }
        return undefined;
      }),
      update: jest.fn(),
    });

    // getApiKey will use cache from previous test or settings
    const headers = await getApiHeaders();
    expect(headers['X-API-Key']).toBeDefined();
  });

  it('merges extra headers', async () => {
    const headers = await getApiHeaders({ 'Content-Type': 'application/json' });
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-API-Key']).toBeDefined();
  });
});
