import {
  addressDomain,
  describeWalletRefusal,
  sameService,
  NwcClient,
  NwcPayoutError,
  classifyNwcError,
  NwcPublishError,
  NwcReplyTimeoutError,
  NwcWalletError,
  parseNwcUri,
  preimageMatches,
  summarizeNwcUri,
  walletPubkeyFromNwcUri,
} from './nwc-client.js';
import { FakeWallet, MemoryPool, makePaymentPair } from '../testing/memory-relay.js';

// Fake invoices "inv:<msat>:<hash>" stand in for bolt11 here; the real decoder
// is covered in lnurl-pay.test.ts.
jest.mock('./bolt11.js', () => ({
  decodeInvoice: (s: string) => {
    const [, msat, hash] = s.split(':');
    if (!hash) {
      throw new Error('not an invoice');
    }
    return { amountMsat: Number(msat), paymentHash: hash, timestamp: 0, expirySeconds: 3600 };
  },
}));

const WALLET = 'b'.repeat(64);
const SECRET = 'c'.repeat(64);
const URI = `nostr+walletconnect://${WALLET}?relay=wss://relay.example.com&secret=${SECRET}&lud16=me%40example.com`;

describe('connection strings', () => {
  it('parses a valid URI', () => {
    expect(parseNwcUri(URI)).toEqual({
      walletPubkey: WALLET,
      relays: ['wss://relay.example.com'],
      secret: SECRET,
      lud16: 'me@example.com',
    });
    expect(walletPubkeyFromNwcUri(URI)).toBe(WALLET);
  });

  it('summarizes without ever exposing the secret', () => {
    const summary = summarizeNwcUri(URI);
    expect(summary).toEqual({ relay: 'relay.example.com', lud16: 'me@example.com' });
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it.each([
    ['', /empty/],
    ['https://example.com', /scheme/],
    [`nostr+walletconnect://nothex?relay=wss://r&secret=${SECRET}`, /wallet pubkey/],
    [`nostr+walletconnect://${WALLET}?secret=${SECRET}`, /relay/],
    [`nostr+walletconnect://${WALLET}?relay=http://r.example&secret=${SECRET}`, /relay/],
    [`nostr+walletconnect://${WALLET}?relay=wss://r`, /secret/],
  ])('rejects %p', (uri, message) => {
    expect(() => parseNwcUri(uri)).toThrow(message);
  });

  it('never echoes the secret in an error', () => {
    try {
      parseNwcUri(`nostr+walletconnect://bad?relay=wss://r&secret=${SECRET}`);
    } catch (e) {
      expect(String(e)).not.toContain(SECRET);
    }
  });
});

describe('outcome classification', () => {
  it('treats only provable non-payments as failed', () => {
    expect(classifyNwcError(new NwcPublishError('x'))).toBe('failed');
    expect(classifyNwcError(new NwcWalletError('INSUFFICIENT_BALANCE', ''))).toBe('failed');
    expect(classifyNwcError(new NwcReplyTimeoutError('pay_invoice', 1))).toBe('unknown');
    expect(classifyNwcError(new Error('anything else'))).toBe('unknown');
  });

  it('checks preimages against payment hashes', () => {
    const { preimage, paymentHash } = makePaymentPair();
    expect(preimageMatches(preimage, paymentHash)).toBe(true);
    expect(preimageMatches('00'.repeat(32), paymentHash)).toBe(false);
    expect(preimageMatches('xyz', paymentHash)).toBe(false);
  });
});

describe('NwcClient against a wallet service', () => {
  let pool: MemoryPool;
  let wallet: FakeWallet;
  let client: NwcClient;

  const invoiceFor = (sats: number) => {
    const pair = makePaymentPair();
    wallet.preimages.set(pair.paymentHash, pair.preimage);
    return { bolt11: `inv:${sats * 1000}:${pair.paymentHash}`, ...pair };
  };

  beforeEach(() => {
    pool = new MemoryPool();
    wallet = new FakeWallet(pool);
    wallet.hashOf = (s) => s.split(':')[2];
    client = new NwcClient(wallet.uri, { pool });
  });

  afterEach(() => {
    wallet.stop();
    client.close();
    pool.close();
  });

  it('reads the info event', async () => {
    await expect(client.getInfo()).resolves.toEqual({
      methods: ['pay_invoice', 'lookup_invoice', 'get_info'],
      encryption: 'nip44_v2',
    });
  });

  it('pays and returns a verified preimage', async () => {
    const inv = invoiceFor(21);
    await expect(client.payInvoice(inv.bolt11, 21)).resolves.toEqual({
      preimage: inv.preimage,
      feesPaidSats: 1,
    });
    expect(pool.openSubscriptions()).toBe(1); // only the wallet's own listener
  });

  it('refuses an invoice for the wrong amount without contacting the wallet', async () => {
    const inv = invoiceFor(21);
    await expect(client.payInvoice(inv.bolt11, 22)).rejects.toMatchObject({ outcome: 'failed' });
    expect(wallet.requests).toHaveLength(0);
  });

  it('reports a decline as failed', async () => {
    wallet.behavior = 'decline';
    const err = await client.payInvoice(invoiceFor(21).bolt11, 21).catch((e) => e);
    expect(err).toBeInstanceOf(NwcPayoutError);
    expect(err.outcome).toBe('failed');
  });

  it('reports a missing reply as unknown — the wallet may have paid', async () => {
    wallet.behavior = 'pay-silently';
    const err = await client.payInvoice(invoiceFor(21).bolt11, 21, 50).catch((e) => e);
    expect(err.outcome).toBe('unknown');
  });

  it('reports a mismatched preimage as unknown', async () => {
    wallet.behavior = 'bad-preimage';
    const err = await client.payInvoice(invoiceFor(21).bolt11, 21).catch((e) => e);
    expect(err.outcome).toBe('unknown');
  });

  it('reports an unreachable relay as failed', async () => {
    await client.getInfo();
    pool.rejecting = true;
    const err = await client.payInvoice(invoiceFor(21).bolt11, 21).catch((e) => e);
    expect(err.outcome).toBe('failed');
    expect(wallet.requests).toHaveLength(0);
  });

  it('looks up a payment that settled silently', async () => {
    wallet.behavior = 'pay-silently';
    const inv = invoiceFor(21);
    await client.payInvoice(inv.bolt11, 21, 50).catch(() => undefined);
    await expect(client.lookupPayment({ paymentHash: inv.paymentHash })).resolves.toEqual({
      state: 'settled',
      preimage: inv.preimage,
    });
  });

  it('reports a failed payment and an unknown one', async () => {
    wallet.payments.set('f'.repeat(64), 'failed');
    await expect(client.lookupPayment({ paymentHash: 'f'.repeat(64) })).resolves.toEqual({
      state: 'failed',
    });
    // NOT_FOUND is not evidence of failure.
    await expect(client.lookupPayment({ paymentHash: 'e'.repeat(64) })).resolves.toMatchObject({
      state: 'unknown',
    });
  });
});

describe('describeWalletRefusal', () => {
  it('tidies the wallet\'s trailing punctuation', () => {
    const err = new NwcWalletError('OTHER', 'Payment failed: Wallet not found: ');
    expect(err.walletMessage).toBe('Payment failed: Wallet not found');
    expect(err.message).toBe('OTHER: Payment failed: Wallet not found');
  });

  it('explains "wallet not found" on the same service and points at the claimant address', () => {
    const text = describeWalletRefusal('OTHER', 'Payment failed: Wallet not found', {
      claimantAddress: 'bob@primal.net',
      walletDomain: 'primal.net',
    });
    expect(text).toContain('Your wallet refused the payment.');
    expect(text).toContain('"Payment failed: Wallet not found"');
    expect(text).toContain('bob@primal.net');
    expect(text).toContain('same service as your wallet (primal.net)');
  });

  it('gives the not-found hint even across services, without claiming they match', () => {
    const text = describeWalletRefusal('OTHER', 'user not found', {
      claimantAddress: 'bob@other.example',
      walletDomain: 'wallet.example',
    });
    expect(text).toContain('may not have a working wallet behind it');
    expect(text).not.toContain('same service');
  });

  it('keeps balance and budget problems about the creator\'s wallet', () => {
    const text = describeWalletRefusal('INSUFFICIENT_BALANCE', 'no funds', {
      claimantAddress: 'bob@primal.net',
      walletDomain: 'primal.net',
    });
    expect(text).toContain("doesn't have enough sats");
    expect(text).not.toContain('claimant');
    expect(describeWalletRefusal('QUOTA_EXCEEDED', '')).toContain('budget');
  });

  it('describes every NIP-47 code it knows', () => {
    for (const code of ['RATE_LIMITED', 'RESTRICTED', 'UNAUTHORIZED', 'PAYMENT_FAILED', 'NOT_IMPLEMENTED', 'INTERNAL']) {
      expect(describeWalletRefusal(code, '')).not.toBe('Your wallet refused the payment.');
    }
  });

  it('extracts and compares service domains', () => {
    expect(addressDomain('Bob@Primal.net')).toBe('primal.net');
    expect(addressDomain('https://www.example.com/lnurlp/x')).toBe('example.com');
    expect(addressDomain('lnurl1garbage')).toBeUndefined();
    expect(sameService('pay.example.com', 'example.com')).toBe(true);
    expect(sameService('example.com', 'other.com')).toBe(false);
    expect(sameService(undefined, 'example.com')).toBe(false);
  });
});
