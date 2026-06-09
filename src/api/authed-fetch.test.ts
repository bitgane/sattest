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
