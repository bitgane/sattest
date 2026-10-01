jest.mock('./nostr-auth', () => ({
  getNostrAuthHeaders: jest.fn(),
}));

import { authedFetch, setAuthRefresher } from './authed-fetch.js';
import { getNostrAuthHeaders } from './nostr-auth.js';

const mockHeaders = getNostrAuthHeaders as jest.Mock;

function res(status: number) {
  return { status, ok: status >= 200 && status < 300, json: async () => ({}) } as Response;
}

describe('authedFetch', () => {
  beforeEach(() => {
    setAuthRefresher(undefined);
    mockHeaders.mockReset().mockImplementation(async (extra?: Record<string, string>) => ({
      Authorization: 'Nostr test',
      ...extra,
    }));
    jest.spyOn(global, 'fetch').mockReset();
  });

  it('returns the response without retry on a 2xx', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(res(200));
    const r = await authedFetch('http://x/y', { method: 'POST' }, { interactiveReauth: true });
    expect(r.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Auth header was attached by the wrapper.
    expect((fetchSpy.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: 'Nostr test' });
  });

  it('retries once on 401 when interactiveReauth and the refresher succeeds', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(res(401))
      .mockResolvedValueOnce(res(200));
    const refresher = jest.fn().mockResolvedValue(true);
    setAuthRefresher(refresher);

    const r = await authedFetch('http://x/y', { method: 'POST' }, { interactiveReauth: true });
    expect(r.status).toBe(200);
    expect(refresher).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 401 when interactiveReauth is false', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(res(401));
    const refresher = jest.fn().mockResolvedValue(true);
    setAuthRefresher(refresher);

    const r = await authedFetch('http://x/y'); // no opts → interactiveReauth defaults false
    expect(r.status).toBe(401);
    expect(refresher).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry when the refresher returns false', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(res(401));
    const refresher = jest.fn().mockResolvedValue(false);
    setAuthRefresher(refresher);

    const r = await authedFetch('http://x/y', {}, { interactiveReauth: true });
    expect(r.status).toBe(401);
    expect(refresher).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // no retry
  });

  it('pops the re-pair QR and retries once on a signer timeout', async () => {
    // A timeout usually means a stale session (ended in the signer app), which
    // re-pairing fixes by minting a fresh pointer — so offer the QR and retry.
    const { SignerTimeoutError } = require('./signer-errors.js');
    mockHeaders
      .mockRejectedValueOnce(new SignerTimeoutError('payout approval'))
      .mockImplementation(async () => ({ Authorization: 'Nostr test' }));
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(res(200));
    const refresher = jest.fn().mockResolvedValue(true);
    setAuthRefresher(refresher);

    const r = await authedFetch(
      'http://x/y',
      { method: 'POST' },
      { interactiveReauth: true, operation: 'payout approval' }
    );
    expect(r.status).toBe(200);
    expect(refresher).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('surfaces the permission-settings diagnosis on a second consecutive timeout', async () => {
    // Re-pairing didn't unstick it → stop looping the QR and tell the user to
    // check their signer's per-signature permission.
    const { SignerTimeoutError } = require('./signer-errors.js');
    mockHeaders.mockRejectedValue(new SignerTimeoutError('payout approval'));
    const refresher = jest.fn().mockResolvedValue(true);
    setAuthRefresher(refresher);

    await expect(
      authedFetch('http://x/y', { method: 'POST' }, { interactiveReauth: true, operation: 'payout approval' })
    ).rejects.toThrow(/permission settings/i);
    expect(refresher).toHaveBeenCalledTimes(1); // offered once, did not loop
  });

  it('propagates a timeout untouched when interactiveReauth is off', async () => {
    // setNwcUri owns its own recovery, so it calls without interactiveReauth.
    const { SignerTimeoutError } = require('./signer-errors.js');
    mockHeaders.mockRejectedValue(new SignerTimeoutError('wallet connection'));
    const refresher = jest.fn().mockResolvedValue(true);
    setAuthRefresher(refresher);

    await expect(authedFetch('http://x/y', {})).rejects.toThrow(/signer didn't respond/);
    expect(refresher).not.toHaveBeenCalled();
  });

  it('propagates a user cancel with no reauth and no request', async () => {
    const { SignerCancelledError } = require('./signer-errors.js');
    mockHeaders.mockRejectedValue(new SignerCancelledError('payout approval'));
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(res(200));
    const refresher = jest.fn().mockResolvedValue(true);
    setAuthRefresher(refresher);

    await expect(
      authedFetch('http://x/y', { method: 'POST' }, { interactiveReauth: true })
    ).rejects.toThrow(/Cancelled/);
    expect(refresher).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still reconnects when the credential is simply missing (not a timeout)', async () => {
    // Contrast with the timeout case: a missing/expired credential IS
    // recoverable by re-pairing, so that path must keep working.
    mockHeaders
      .mockRejectedValueOnce(new Error('Nostr authentication required (write scope).'))
      .mockImplementation(async () => ({ Authorization: 'Nostr test' }));
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(res(200));
    const refresher = jest.fn().mockResolvedValue(true);
    setAuthRefresher(refresher);

    const r = await authedFetch('http://x/y', {}, { interactiveReauth: true });
    expect(r.status).toBe(200);
    expect(refresher).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry when no refresher is registered', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(res(401));
    const r = await authedFetch('http://x/y', {}, { interactiveReauth: true });
    expect(r.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent reauths — one refresher call for N parallel 401s', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      // three initial 401s, then three successful retries
      .mockResolvedValueOnce(res(401))
      .mockResolvedValueOnce(res(401))
      .mockResolvedValueOnce(res(401))
      .mockResolvedValueOnce(res(200))
      .mockResolvedValueOnce(res(200))
      .mockResolvedValueOnce(res(200));
    let resolveReauth: (v: boolean) => void = () => {};
    const refresher = jest.fn().mockReturnValue(new Promise<boolean>((r) => { resolveReauth = r; }));
    setAuthRefresher(refresher);

    const calls = Promise.all([
      authedFetch('http://x/1', {}, { interactiveReauth: true }),
      authedFetch('http://x/2', {}, { interactiveReauth: true }),
      authedFetch('http://x/3', {}, { interactiveReauth: true }),
    ]);
    // Let all three hit their 401 and await the shared reauth, then resolve it.
    await Promise.resolve();
    resolveReauth(true);
    const results = await calls;

    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(refresher).toHaveBeenCalledTimes(1); // shared in-flight reauth
    expect(fetchSpy).toHaveBeenCalledTimes(6); // 3 initial + 3 retries
  });

  it('reauths and retries when getNostrAuthHeaders throws (no stored event)', async () => {
    mockHeaders
      .mockRejectedValueOnce(new Error('Nostr authentication required'))
      .mockImplementation(async () => ({ Authorization: 'Nostr fresh' }));
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(res(200));
    const refresher = jest.fn().mockResolvedValue(true);
    setAuthRefresher(refresher);

    const r = await authedFetch('http://x/y', {}, { interactiveReauth: true });
    expect(r.status).toBe(200);
    expect(refresher).toHaveBeenCalledTimes(1);
    // First attempt threw before fetch; only the retry actually fetched.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('propagates the throw when header-building fails and reauth is not allowed', async () => {
    mockHeaders.mockRejectedValue(new Error('Nostr authentication required'));
    await expect(authedFetch('http://x/y')).rejects.toThrow(/authentication required/);
  });
});
