jest.mock('../state', () => ({
  getNostrAuthEvent: jest.fn(),
  initializeSecrets: jest.fn(),
}));

jest.mock('./config', () => ({
  getBackendUrl: jest.fn().mockReturnValue('https://api.sattest.example'),
}));

jest.mock('./nostr.api', () => ({
  signMoneyAuthEvent: jest.fn(),
}));

import { getNostrAuthHeaders, getNostrMoneyAuthHeaders } from './nostr-auth.js';
import { getNostrAuthEvent } from '../state.js';
import { signMoneyAuthEvent } from './nostr.api.js';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('getNostrAuthHeaders', () => {
  it('returns Authorization header with base64-encoded event', async () => {
    const mockEvent = JSON.stringify({ kind: 22242, content: 'sattest-auth' });
    (getNostrAuthEvent as jest.Mock).mockResolvedValue(mockEvent);

    const headers = await getNostrAuthHeaders();

    const expectedEncoded = Buffer.from(JSON.stringify(JSON.parse(mockEvent))).toString('base64');
    expect(headers).toEqual({
      Authorization: `Nostr ${expectedEncoded}`,
    });
  });

  it('merges extra headers', async () => {
    const mockEvent = JSON.stringify({ kind: 22242 });
    (getNostrAuthEvent as jest.Mock).mockResolvedValue(mockEvent);

    const headers = await getNostrAuthHeaders({ 'Content-Type': 'application/json' });

    const expectedEncoded = Buffer.from(JSON.stringify(JSON.parse(mockEvent))).toString('base64');
    expect(headers).toEqual({
      Authorization: `Nostr ${expectedEncoded}`,
      'Content-Type': 'application/json',
    });
  });

  it('throws when no auth event is stored', async () => {
    (getNostrAuthEvent as jest.Mock).mockResolvedValue(undefined);

    await expect(getNostrAuthHeaders()).rejects.toThrow('Nostr authentication required');
  });

  it('throws when auth event is null', async () => {
    (getNostrAuthEvent as jest.Mock).mockResolvedValue(null);

    await expect(getNostrAuthHeaders()).rejects.toThrow('Nostr authentication required');
  });
});

describe('getNostrMoneyAuthHeaders (F4: nonce-bound write credential)', () => {
  beforeEach(() => {
    (getNostrAuthEvent as jest.Mock).mockReset();
    (signMoneyAuthEvent as jest.Mock).mockReset();
    jest.spyOn(global, 'fetch').mockReset();
  });

  it('fetches a nonce with the read credential, signs a fresh write event with it, and encodes the header', async () => {
    const readEvent = JSON.stringify({ kind: 22242, content: 'sattest-auth' });
    (getNostrAuthEvent as jest.Mock).mockResolvedValue(readEvent);
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(jsonResponse(200, { nonce: 'server-nonce-123', expiresAt: 123 }));
    const signedWriteEvent = { kind: 22242, content: 'sattest-auth:write', sig: 'fake-sig' };
    (signMoneyAuthEvent as jest.Mock).mockResolvedValue(signedWriteEvent);

    const headers = await getNostrMoneyAuthHeaders();

    // Nonce request goes to the backend's nonce endpoint, authenticated with
    // the (cheap, cached) read credential — not the write one.
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.sattest.example/auth/nonce',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: expect.stringContaining('Nostr ') }),
      })
    );
    // The fetched nonce is threaded into the fresh signing call.
    expect(signMoneyAuthEvent).toHaveBeenCalledWith('server-nonce-123');

    const expectedEncoded = Buffer.from(JSON.stringify(signedWriteEvent)).toString('base64');
    expect(headers).toEqual({ Authorization: `Nostr ${expectedEncoded}` });
  });

  it('merges extra headers', async () => {
    (getNostrAuthEvent as jest.Mock).mockResolvedValue(JSON.stringify({ kind: 22242 }));
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(200, { nonce: 'n1' }));
    const signedWriteEvent = { kind: 22242, sig: 'fake' };
    (signMoneyAuthEvent as jest.Mock).mockResolvedValue(signedWriteEvent);

    const headers = await getNostrMoneyAuthHeaders({ 'Content-Type': 'application/json' });

    expect(headers['Content-Type']).toBe('application/json');
  });

  it('does not call signMoneyAuthEvent when fetching the nonce fails', async () => {
    (getNostrAuthEvent as jest.Mock).mockResolvedValue(JSON.stringify({ kind: 22242 }));
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(401, { error: 'expired' }));

    await expect(getNostrMoneyAuthHeaders()).rejects.toThrow(/Failed to obtain auth nonce/);
    expect(signMoneyAuthEvent).not.toHaveBeenCalled();
  });

  it('throws when the backend response has no nonce field', async () => {
    (getNostrAuthEvent as jest.Mock).mockResolvedValue(JSON.stringify({ kind: 22242 }));
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(200, {}));

    await expect(getNostrMoneyAuthHeaders()).rejects.toThrow(/did not return a nonce/);
    expect(signMoneyAuthEvent).not.toHaveBeenCalled();
  });

  it('propagates when no read credential is stored yet (surfaces as reconnect-needed)', async () => {
    (getNostrAuthEvent as jest.Mock).mockResolvedValue(undefined);

    await expect(getNostrMoneyAuthHeaders()).rejects.toThrow('Nostr authentication required');
    expect(signMoneyAuthEvent).not.toHaveBeenCalled();
  });

  it('propagates when signMoneyAuthEvent itself throws (e.g. no bunker pointer persisted)', async () => {
    (getNostrAuthEvent as jest.Mock).mockResolvedValue(JSON.stringify({ kind: 22242 }));
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(200, { nonce: 'n1' }));
    (signMoneyAuthEvent as jest.Mock).mockRejectedValue(new Error('Nostr authentication required (write scope)'));

    await expect(getNostrMoneyAuthHeaders()).rejects.toThrow(/write scope/);
  });
});
