import * as vscode from 'vscode';

jest.mock('./nostr-auth', () => ({
  getNostrAuthHeaders: jest.fn().mockImplementation(async (extra?: Record<string, string>) => ({
    Authorization: 'Nostr dGVzdC1hdXRoLWV2ZW50',
    ...extra,
  })),
}));

jest.mock('./config', () => ({
  getBackendUrl: jest.fn().mockReturnValue('http://localhost:3000'),
}));

import { setNwcUri, clearNwcUri, getNwcStatus } from './nwc.api.js';

describe('setNwcUri', () => {
  it('PATCHes /users/me/nwc with trimmed URI and returns true on success', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ configured: true }),
    } as any);

    const ok = await setNwcUri('  nostr+walletconnect://abc?secret=xyz  ');
    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:3000/users/me/nwc',
      expect.objectContaining({ method: 'PATCH' })
    );
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.uri).toBe('nostr+walletconnect://abc?secret=xyz');
    // budget fields omitted when not provided — keeps wire format minimal
    expect(body.budgetSats).toBeUndefined();
    expect(body.budgetWindow).toBeUndefined();
  });

  it('forwards budgetSats and budgetWindow when provided', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ configured: true }),
    } as any);

    await setNwcUri('nostr+walletconnect://x', 50000, 'weekly');
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body).toEqual({
      uri: 'nostr+walletconnect://x',
      budgetSats: 50000,
      budgetWindow: 'weekly',
    });
  });

  it('returns false and surfaces a toast on non-OK response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Invalid URI',
    } as any);

    const ok = await setNwcUri('nostr+walletconnect://bad');
    expect(ok).toBe(false);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to connect wallet')
    );
  });

  it('returns false on network error', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
    const ok = await setNwcUri('nostr+walletconnect://x');
    expect(ok).toBe(false);
  });
});

describe('clearNwcUri', () => {
  it('DELETEs /users/me/nwc and returns true on success', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
    } as any);

    const ok = await clearNwcUri();
    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:3000/users/me/nwc',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('returns false and surfaces a toast on non-OK response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'oops',
    } as any);

    const ok = await clearNwcUri();
    expect(ok).toBe(false);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to disconnect wallet')
    );
  });
});

describe('getNwcStatus', () => {
  it('returns the parsed status on success', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        configured: true,
        budgetSats: 100000,
        budgetWindow: 'monthly',
        updatedAt: '2026-04-24T00:00:00.000Z',
      }),
    } as any);

    const status = await getNwcStatus();
    expect(status).toEqual({
      configured: true,
      budgetSats: 100000,
      budgetWindow: 'monthly',
      updatedAt: '2026-04-24T00:00:00.000Z',
    });
  });

  it('returns {configured: false} on non-OK response — never blocks the UI', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
    } as any);

    const status = await getNwcStatus();
    expect(status).toEqual({ configured: false });
  });

  it('returns {configured: false} on network error', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
    const status = await getNwcStatus();
    expect(status).toEqual({ configured: false });
  });
});
