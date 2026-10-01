import * as vscode from 'vscode';

jest.mock('../state', () => ({
  getLnbitsUrl: jest.fn(),
  getLnbitsApiKey: jest.fn(),
  setLnbitsUrl: jest.fn().mockResolvedValue(undefined),
  setLnbitsApiKey: jest.fn().mockResolvedValue(undefined),
  setIsDefaultLnbits: jest.fn().mockResolvedValue(undefined),
  initializeSecrets: jest.fn(),
}));

import { getLnbitsConfig, configureLnbits, createLnbitsInvoice } from './lnbits.api.js';
import { getLnbitsUrl, getLnbitsApiKey, setLnbitsUrl, setLnbitsApiKey } from '../state.js';

describe('getLnbitsConfig', () => {
  it('returns config when both url and apiKey are present', async () => {
    (getLnbitsUrl as jest.Mock).mockResolvedValue('https://lnbits.example.com');
    (getLnbitsApiKey as jest.Mock).mockResolvedValue('admin-key');

    const config = await getLnbitsConfig();
    expect(config).toEqual({ url: 'https://lnbits.example.com', apiKey: 'admin-key' });
  });

  it('returns null when url is missing', async () => {
    (getLnbitsUrl as jest.Mock).mockResolvedValue(undefined);
    (getLnbitsApiKey as jest.Mock).mockResolvedValue('admin-key');

    const config = await getLnbitsConfig();
    expect(config).toBeNull();
  });

  it('returns null when apiKey is missing', async () => {
    (getLnbitsUrl as jest.Mock).mockResolvedValue('https://lnbits.example.com');
    (getLnbitsApiKey as jest.Mock).mockResolvedValue(undefined);

    const config = await getLnbitsConfig();
    expect(config).toBeNull();
  });

  it('returns null when both are missing', async () => {
    (getLnbitsUrl as jest.Mock).mockResolvedValue(undefined);
    (getLnbitsApiKey as jest.Mock).mockResolvedValue(undefined);

    const config = await getLnbitsConfig();
    expect(config).toBeNull();
  });
});

describe('configureLnbits', () => {
  it('saves URL and API key when both provided', async () => {
    (vscode.window.showInputBox as jest.Mock)
      .mockResolvedValueOnce('https://my-lnbits.com')
      .mockResolvedValueOnce('super-secret-key-12345');

    await configureLnbits();

    expect(setLnbitsUrl).toHaveBeenCalledWith('https://my-lnbits.com');
    expect(setLnbitsApiKey).toHaveBeenCalledWith('super-secret-key-12345');
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('LNbits configuration saved')
    );
  });

  it('aborts when user cancels URL input', async () => {
    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce(undefined);

    await configureLnbits();

    expect(setLnbitsUrl).not.toHaveBeenCalled();
    expect(setLnbitsApiKey).not.toHaveBeenCalled();
  });

  it('aborts when user cancels API key input', async () => {
    (vscode.window.showInputBox as jest.Mock)
      .mockResolvedValueOnce('https://my-lnbits.com')
      .mockResolvedValueOnce(undefined);

    await configureLnbits();

    expect(setLnbitsUrl).not.toHaveBeenCalled();
    expect(setLnbitsApiKey).not.toHaveBeenCalled();
  });

  it('URL validateInput accepts http URLs and rejects others', async () => {
    let urlValidator: ((v: string) => string | null) | undefined;
    (vscode.window.showInputBox as jest.Mock).mockImplementation((options: any) => {
      if (options.title?.includes('URL') && options.validateInput) {
        urlValidator = options.validateInput;
      }
      return Promise.resolve(undefined);
    });

    await configureLnbits();

    expect(urlValidator).toBeDefined();
    expect(urlValidator!('https://example.com')).toBeNull();
    expect(urlValidator!('http://localhost:3007')).toBeNull();
    expect(urlValidator!('ftp://bad')).toBe('Must start with http(s)://');
    expect(urlValidator!('not-a-url')).toBe('Must start with http(s)://');
  });

  it('API key validateInput accepts keys > 10 chars', async () => {
    let keyValidator: ((v: string) => string | null) | undefined;
    let callCount = 0;
    (vscode.window.showInputBox as jest.Mock).mockImplementation((options: any) => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve('https://example.com');
      }
      if (options.password && options.validateInput) {
        keyValidator = options.validateInput;
      }
      return Promise.resolve(undefined);
    });

    await configureLnbits();

    expect(keyValidator).toBeDefined();
    expect(keyValidator!('a'.repeat(11))).toBeNull();
    expect(keyValidator!('short')).toBe('Key looks too short');
    expect(keyValidator!('exactly10!')).toBe('Key looks too short');
  });
});

describe('createLnbitsInvoice', () => {
  it('creates invoice and returns payment_request and payment_hash', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        payment_request: 'lnbc10000...',
        payment_hash: 'hash_abc',
      }),
    } as any);

    const result = await createLnbitsInvoice(
      'https://lnbits.example.com',
      'admin-key',
      10000,
      'Test bounty memo'
    );

    expect(result).toEqual({
      payment_request: 'lnbc10000...',
      payment_hash: 'hash_abc',
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://lnbits.example.com/api/v1/payments',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': 'admin-key',
        },
        body: JSON.stringify({
          out: false,
          amount: 10000,
          memo: 'Test bounty memo',
        }),
      })
    );
  });

  it('throws on non-OK response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    } as any);

    await expect(
      createLnbitsInvoice('https://lnbits.example.com', 'bad-key', 5000, 'memo')
    ).rejects.toThrow('LNbits error: 401 - Unauthorized');
  });

  it('throws on network error', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('connection refused'));

    await expect(
      createLnbitsInvoice('https://lnbits.example.com', 'key', 5000, 'memo')
    ).rejects.toThrow('connection refused');
  });
});
