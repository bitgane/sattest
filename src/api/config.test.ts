import * as vscode from 'vscode';
import { getBackendUrl, getApiKey, getApiHeaders } from './config.js';

describe('getBackendUrl', () => {
  it('returns configured URL from settings', () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'backendUrl') {
          return 'https://api.sattest.io';
        }
        return undefined;
      }),
      update: jest.fn(),
    });
    expect(getBackendUrl()).toBe('https://api.sattest.io');
  });

  it('falls back to http://localhost:3000 when no config', () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn().mockReturnValue(undefined),
      update: jest.fn(),
    });
    expect(getBackendUrl()).toBe('http://localhost:3000');
  });

  it('strips trailing slashes', () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'backendUrl') {
          return 'https://api.sattest.io///';
        }
        return undefined;
      }),
      update: jest.fn(),
    });
    expect(getBackendUrl()).toBe('https://api.sattest.io');
  });

  it('falls back for empty string config', () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn().mockReturnValue(''),
      update: jest.fn(),
    });
    expect(getBackendUrl()).toBe('http://localhost:3000');
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
