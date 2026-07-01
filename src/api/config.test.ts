import * as vscode from 'vscode';
import { getBackendUrl } from './config.js';

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
