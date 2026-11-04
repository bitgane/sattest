import {
  bech32Decode,
  fetchInvoiceForAmount,
  fetchLnurlLimits,
  resolveLnurlEndpoint,
  type LnurlFetch,
} from './lnurl-pay.js';
import { decodeInvoice, invoiceIsLive, paymentHashFromBolt11 } from './bolt11.js';

jest.mock('node:dns/promises', () => ({
  lookup: jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

// BOLT11 spec test vector: 2500u = 250,000 sats.
const SPEC_INVOICE =
  'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh';
const SPEC_HASH = '0001020304050607080900010203040506070809000102030405060708090102';

function jsonBody(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  return {
    ok: true,
    status: 200,
    body: (async function* () {
      yield bytes;
    })(),
  };
}

function fakeServer(routes: Record<string, unknown>): { fetchImpl: LnurlFetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: LnurlFetch = async (url) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) {
      return { ok: false, status: 404, body: null };
    }
    return jsonBody(routes[key]);
  };
  return { fetchImpl, calls };
}

describe('bolt11', () => {
  it('reads the amount and payment hash', () => {
    const d = decodeInvoice(SPEC_INVOICE);
    expect(d.amountMsat).toBe(250_000_000);
    expect(d.paymentHash).toBe(SPEC_HASH);
    expect(paymentHashFromBolt11(SPEC_INVOICE)).toBe(SPEC_HASH);
    expect(paymentHashFromBolt11('lnbcgarbage')).toBeUndefined();
  });

  it('knows when an invoice has expired', () => {
    const d = decodeInvoice(SPEC_INVOICE); // created 2017, 60 s expiry
    expect(invoiceIsLive(d)).toBe(false);
    expect(invoiceIsLive(d, d.timestamp + 1, 0)).toBe(true);
  });
});

describe('resolveLnurlEndpoint', () => {
  it('maps a Lightning address to its well-known endpoint', () => {
    expect(resolveLnurlEndpoint('alice@Example.com')).toBe(
      'https://example.com/.well-known/lnurlp/alice'
    );
  });

  it('decodes a bech32 LNURL (LUD-01 test vector)', () => {
    const lnurl =
      'LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS';
    expect(resolveLnurlEndpoint(lnurl)).toBe(
      'https://service.com/api?q=3fc3645b439ce8e7f2553a69e5267081d96dcd340693afabe04be7b0ccd178df'
    );
  });

  it('rejects a corrupted bech32 string', () => {
    expect(() => bech32Decode('lnurl1dp68gurn8ghj7qqqqqq')).toThrow();
  });

  it('rejects unknown formats', () => {
    expect(() => resolveLnurlEndpoint('not an address')).toThrow(/Unrecognised/);
  });
});

describe('fetchInvoiceForAmount', () => {
  const payRequest = {
    tag: 'payRequest',
    callback: 'https://example.com/cb',
    minSendable: 1_000,
    maxSendable: 500_000_000,
  };

  it('returns an invoice for exactly the requested amount', async () => {
    const { fetchImpl, calls } = fakeServer({
      'https://example.com/.well-known/lnurlp/alice': payRequest,
      'https://example.com/cb': { pr: SPEC_INVOICE },
    });
    await expect(
      fetchInvoiceForAmount('alice@example.com', 250_000_000, undefined, { fetchImpl })
    ).resolves.toBe(SPEC_INVOICE);
    expect(calls[1]).toBe('https://example.com/cb?amount=250000000');
  });

  it('refuses an invoice that asks for a different amount', async () => {
    const { fetchImpl } = fakeServer({
      'https://example.com/.well-known/lnurlp/alice': payRequest,
      'https://example.com/cb': { pr: SPEC_INVOICE },
    });
    await expect(
      fetchInvoiceForAmount('alice@example.com', 1_000_000, undefined, { fetchImpl })
    ).rejects.toThrow(/does not match/);
  });

  it('refuses an amount outside the LNURL bounds before asking for an invoice', async () => {
    const { fetchImpl, calls } = fakeServer({
      'https://example.com/.well-known/lnurlp/alice': { ...payRequest, maxSendable: 10_000 },
    });
    await expect(
      fetchInvoiceForAmount('alice@example.com', 250_000_000, undefined, { fetchImpl })
    ).rejects.toThrow(/outside/);
    expect(calls).toHaveLength(1);
  });

  it('refuses a callback pointing into a private network', async () => {
    const { fetchImpl } = fakeServer({
      'https://example.com/.well-known/lnurlp/alice': { ...payRequest, callback: 'https://127.0.0.1/cb' },
    });
    await expect(
      fetchInvoiceForAmount('alice@example.com', 250_000_000, undefined, { fetchImpl })
    ).rejects.toThrow(/non-public/);
  });

  it('surfaces LNURL error responses', async () => {
    const { fetchImpl } = fakeServer({
      'https://example.com/.well-known/lnurlp/alice': { status: 'ERROR', reason: 'no such user' },
    });
    await expect(fetchLnurlLimits('alice@example.com', { fetchImpl })).rejects.toThrow(
      /no such user/
    );
  });

  it('reports the sendable range', async () => {
    const { fetchImpl } = fakeServer({ 'https://example.com/.well-known/lnurlp/alice': payRequest });
    await expect(fetchLnurlLimits('alice@example.com', { fetchImpl })).resolves.toEqual({
      minSendable: 1_000,
      maxSendable: 500_000_000,
    });
  });
});
