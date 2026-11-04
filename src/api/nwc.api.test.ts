import * as vscode from 'vscode';
import { clearNwcUri, getNwcStatus, setNwcUri } from './nwc.api.js';
import { initializeSecrets, getNwcUri } from '../state.js';

const WALLET = 'b'.repeat(64);
const SECRET = 'c'.repeat(64);
const URI = `nostr+walletconnect://${WALLET}?relay=wss://relay.example.com&secret=${SECRET}&lud16=me%40example.com`;

function mockContext(): vscode.ExtensionContext {
  const secrets = new Map<string, string>();
  const global = new Map<string, unknown>();
  return {
    globalState: {
      get: (k: string) => global.get(k),
      update: async (k: string, v: unknown) => {
        global.set(k, v);
      },
    },
    secrets: {
      get: async (k: string) => secrets.get(k),
      store: async (k: string, v: string) => {
        secrets.set(k, v);
      },
      delete: async (k: string) => {
        secrets.delete(k);
      },
    },
  } as unknown as vscode.ExtensionContext;
}

function fakeClient(methods: string[] | Error) {
  return () => ({
    walletPubkey: WALLET,
    getInfo: async () => {
      if (methods instanceof Error) {
        throw methods;
      }
      return { methods, encryption: 'nip44_v2' as const };
    },
    close: jest.fn(),
  });
}

beforeEach(() => {
  initializeSecrets(mockContext());
  jest.clearAllMocks();
});

describe('setNwcUri', () => {
  it('stores the connection locally — it is never sent anywhere', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch' as never);
    const result = await setNwcUri(`  ${URI}  `, 100_000, 'weekly', {
      client: fakeClient(['pay_invoice', 'lookup_invoice']),
    });
    expect(result).toBe('ok');
    expect(await getNwcUri()).toBe(URI);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await getNwcStatus()).toMatchObject({
      configured: true,
      relay: 'relay.example.com',
      lud16: 'me@example.com',
      budgetSats: 100_000,
      budgetWindow: 'weekly',
    });
  });

  it('rejects a malformed connection string without storing it', async () => {
    expect(await setNwcUri('nostr+walletconnect://nope', undefined, undefined)).toBe('failed');
    expect(await getNwcUri()).toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
  });

  it('refuses a connection that does not allow looking up payments', async () => {
    const result = await setNwcUri(URI, undefined, undefined, {
      client: fakeClient(['pay_invoice']),
    });
    expect(result).toBe('failed');
    expect(await getNwcUri()).toBeUndefined();
    expect((vscode.window.showErrorMessage as jest.Mock).mock.calls[0][0]).toMatch(/lookup_invoice/);
  });

  it('still saves when the wallet info can not be read right now', async () => {
    const result = await setNwcUri(URI, undefined, undefined, {
      client: fakeClient(new Error('relay down')),
    });
    expect(result).toBe('ok');
  });

  it('never puts the secret in an error message', async () => {
    await setNwcUri(`nostr+walletconnect://bad?relay=wss://r&secret=${SECRET}`);
    for (const call of (vscode.window.showErrorMessage as jest.Mock).mock.calls) {
      expect(String(call[0])).not.toContain(SECRET);
    }
  });
});

describe('clearNwcUri / getNwcStatus', () => {
  it('reports not configured by default', async () => {
    expect(await getNwcStatus()).toEqual({ configured: false });
  });

  it('forgets the connection', async () => {
    await setNwcUri(URI, undefined, undefined, { client: fakeClient([]) });
    expect(await clearNwcUri()).toBe(true);
    expect(await getNwcUri()).toBeUndefined();
    expect(await getNwcStatus()).toEqual({ configured: false });
  });
});
