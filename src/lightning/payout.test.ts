import {
  approveAndPay,
  PayoutDeps,
  PayoutJournal,
  PayoutWallet,
  resolveHeldPayout,
  sweepJournal,
  KeyValueStore,
} from './payout.js';
import { NwcPayoutError, NwcWalletError, type NwcPaymentLookup } from './nwc-client.js';
import type { BountyInfo, BountyPayout, ClaimInfo } from '../bounty/bounty.types.js';
import type { BountyEventStatus } from '../api/nostr-protocol.js';

jest.mock('./bolt11.js', () => ({
  decodeInvoice: (s: string) => ({
    amountMsat: Number(s.split(':')[1]),
    paymentHash: s.split(':')[2],
    timestamp: 0,
    expirySeconds: 3600,
  }),
}));

const CLAIMANT = 'c'.repeat(64);
const WALLET = 'w'.repeat(64);

function memoryStore(): KeyValueStore {
  const data = new Map<string, unknown>();
  return {
    get: <T>(k: string) => data.get(k) as T | undefined,
    update: async (k: string, v: unknown) => {
      data.set(k, v);
    },
  };
}

function claimInfo(id = 'claim-1'): ClaimInfo {
  return {
    id,
    bountyId: 'b-1',
    claimantPubkey: CLAIMANT,
    claimedAt: new Date(),
    status: 'pending',
    encryptedLnurl: 'enc',
    ephemeralPubkey: 'e'.repeat(64),
    publicConsent: false,
  };
}

function bountyInfo(): BountyInfo {
  return {
    id: 'b-1',
    coordinate: `37400:${'a'.repeat(64)}:b-1`,
    eventId: 'ev-1',
    eventCreatedAt: 1000,
    createdAt: new Date(),
    creatorId: 'a'.repeat(64),
    amountSats: 21,
    testId: '/t#x',
    status: 'open',
    active: true,
    claims: [claimInfo()],
  };
}

class FakeWallet implements PayoutWallet {
  walletPubkey = WALLET;
  walletDomain = 'example.com';
  payResult: 'ok' | 'failed' | 'not-found' | 'unknown' = 'ok';
  lookupResult: NwcPaymentLookup = { state: 'unknown', reason: 'n/a' };
  payCalls: string[] = [];
  async payInvoice(bolt11: string) {
    this.payCalls.push(bolt11);
    if (this.payResult === 'failed') {
      throw new NwcPayoutError('declined', 'failed');
    }
    if (this.payResult === 'not-found') {
      const cause = new NwcWalletError('OTHER', 'Payment failed: Wallet not found: ');
      throw new NwcPayoutError(cause.message, 'failed', cause);
    }
    if (this.payResult === 'unknown') {
      throw new NwcPayoutError('timeout', 'unknown');
    }
    return { preimage: 'pre-' + bolt11.split(':')[2] };
  }
  async lookupPayment() {
    return this.lookupResult;
  }
  close() {}
}

function setup() {
  let relayState: BountyInfo = bountyInfo();
  const published: Array<{ status: BountyEventStatus; payout?: BountyPayout }> = [];
  const wallet = new FakeWallet();
  let invoiceCounter = 0;
  const journal = new PayoutJournal(memoryStore());
  const deps: PayoutDeps & { relayDown: boolean; walletConnected: boolean } = {
    journal,
    relayDown: false,
    walletConnected: true,
    openWallet: async () => (deps.walletConnected ? wallet : undefined),
    refetchBounty: async () => structuredClone(relayState),
    publishStatus: async (_b, status, payout) => {
      if (deps.relayDown) {
        throw new Error('no relay accepted');
      }
      published.push({ status, payout });
      relayState = { ...relayState, status, payout, eventCreatedAt: relayState.eventCreatedAt + 1 };
      relayState.active = status === 'open' || status === 'approving';
      return structuredClone(relayState);
    },
    publishStatusEventually: async (b, status, payout) => {
      try {
        return await deps.publishStatus(b, status, payout);
      } catch {
        return b; // queued
      }
    },
    decryptLnurl: async () => 'alice@example.com',
    fetchInvoice: async (_l, msat) => `inv:${msat}:hash-${++invoiceCounter}`,
    sleep: async () => undefined,
  };
  return {
    deps,
    wallet,
    journal,
    published,
    get relay() {
      return relayState;
    },
    set relay(v: BountyInfo) {
      relayState = v;
    },
  };
}

describe('approveAndPay', () => {
  it('locks, pays and publishes a verifiable receipt', async () => {
    const t = setup();
    const result = await approveAndPay(t.deps, bountyInfo(), claimInfo());
    expect(result).toMatchObject({ kind: 'paid', preimage: 'pre-hash-1' });
    expect(t.published.map((p) => p.status)).toEqual(['approving', 'paid']);
    expect(t.published[0].payout).toMatchObject({ claimantPubkey: CLAIMANT, paymentHash: 'hash-1' });
    expect(t.published[1].payout).toMatchObject({ preimage: 'pre-hash-1', paymentHash: 'hash-1' });
    expect(t.journal.get(t.relay.coordinate)?.state).toBe('paid');
  });

  it('pays nothing when the lock cannot be published', async () => {
    const t = setup();
    t.deps.relayDown = true;
    const result = await approveAndPay(t.deps, bountyInfo(), claimInfo());
    expect(result.kind).toBe('error');
    expect(t.wallet.payCalls).toHaveLength(0);
    expect(t.journal.get(t.relay.coordinate)).toBeUndefined();
  });

  it('releases the lock when the wallet provably did not pay', async () => {
    const t = setup();
    t.wallet.payResult = 'failed';
    const result = await approveAndPay(t.deps, bountyInfo(), claimInfo());
    expect(result).toMatchObject({ kind: 'error' });
    expect(t.relay.status).toBe('open');
    expect(t.journal.get(t.relay.coordinate)).toBeUndefined();
  });

  it('explains a wallet refusal, says nothing was sent, and keeps the claim payable', async () => {
    const t = setup();
    t.wallet.payResult = 'not-found';
    const result = await approveAndPay(t.deps, bountyInfo(), claimInfo());
    expect(result.kind).toBe('error');
    const message = (result as { message: string }).message;
    expect(message).toContain('"Payment failed: Wallet not found"');
    expect(message).toContain('alice@example.com');
    expect(message).toContain('same service as your wallet (example.com)');
    expect(message).toContain('Nothing was sent');
    expect(t.relay.status).toBe('open');
    expect(t.journal.get(t.relay.coordinate)).toBeUndefined();
  });

  it('keeps the hold when the outcome is unknown, then settles it without paying twice', async () => {
    const t = setup();
    t.wallet.payResult = 'unknown';
    expect((await approveAndPay(t.deps, bountyInfo(), claimInfo())).kind).toBe('outcome-unknown');
    expect(t.relay.status).toBe('approving');
    expect(t.journal.get(t.relay.coordinate)?.state).toBe('approving');

    // Still unknown → stays held, no second payment.
    expect((await approveAndPay(t.deps, bountyInfo(), claimInfo())).kind).toBe('in-progress');
    expect(t.wallet.payCalls).toHaveLength(1);

    // The wallet now confirms it paid → finalized, still one payment.
    t.wallet.lookupResult = { state: 'settled', preimage: 'pre-hash-1' };
    expect((await approveAndPay(t.deps, bountyInfo(), claimInfo())).kind).toBe('already-approved');
    expect(t.relay.status).toBe('paid');
    expect(t.relay.payout?.preimage).toBe('pre-hash-1');
    expect(t.wallet.payCalls).toHaveLength(1);
  });

  it('retries after the wallet confirms the held attempt failed', async () => {
    const t = setup();
    t.wallet.payResult = 'unknown';
    await approveAndPay(t.deps, bountyInfo(), claimInfo());
    t.wallet.lookupResult = { state: 'failed' };
    t.wallet.payResult = 'ok';
    const result = await approveAndPay(t.deps, bountyInfo(), claimInfo());
    expect(result.kind).toBe('paid');
    expect(t.wallet.payCalls).toEqual(['inv:21000:hash-1', 'inv:21000:hash-2']);
  });

  it('asks the creator when a different wallet is connected now', async () => {
    const t = setup();
    t.wallet.payResult = 'unknown';
    await approveAndPay(t.deps, bountyInfo(), claimInfo());
    t.wallet.walletPubkey = 'x'.repeat(64);
    expect((await approveAndPay(t.deps, bountyInfo(), claimInfo())).kind).toBe('needs-confirmation');
  });

  it('asks the creator when another device holds the payout', async () => {
    const t = setup();
    t.relay = {
      ...t.relay,
      status: 'approving',
      payout: { claimantPubkey: CLAIMANT, paymentHash: 'other-device' },
    };
    expect((await approveAndPay(t.deps, bountyInfo(), claimInfo())).kind).toBe('needs-confirmation');
    expect(t.wallet.payCalls).toHaveLength(0);
  });

  it('refuses a claim that changed after review', async () => {
    const t = setup();
    t.relay = { ...t.relay, claims: [claimInfo('claim-2')] };
    expect((await approveAndPay(t.deps, bountyInfo(), claimInfo('claim-1'))).kind).toBe(
      'claimant-changed'
    );
  });

  it('reports a bounty that is already paid', async () => {
    const t = setup();
    t.relay = { ...t.relay, status: 'paid' };
    expect((await approveAndPay(t.deps, bountyInfo(), claimInfo())).kind).toBe('already-approved');
  });

  it('stands down when another device won the race', async () => {
    const t = setup();
    const realPublish = t.deps.publishStatus;
    t.deps.publishStatus = async (b, status, payout) => {
      const out = await realPublish(b, status, payout);
      if (status === 'approving') {
        // Another device published a newer approving version.
        t.relay = { ...t.relay, payout: { ...t.relay.payout, paymentHash: 'device-b' } };
      }
      return out;
    };
    expect((await approveAndPay(t.deps, bountyInfo(), claimInfo())).kind).toBe('in-progress');
    expect(t.wallet.payCalls).toHaveLength(0);
  });
});

describe('resolveHeldPayout', () => {
  it('records a creator-confirmed payment without a preimage', async () => {
    const t = setup();
    t.wallet.payResult = 'unknown';
    await approveAndPay(t.deps, bountyInfo(), claimInfo());
    await resolveHeldPayout(t.deps, t.relay, 'paid');
    expect(t.relay.status).toBe('paid');
    expect(t.relay.payout).toMatchObject({ resolution: 'creator-confirmed', paymentHash: 'hash-1' });
    expect(t.relay.payout?.preimage).toBeUndefined();
  });

  it('unlocks a payment the creator says did not happen', async () => {
    const t = setup();
    t.wallet.payResult = 'unknown';
    await approveAndPay(t.deps, bountyInfo(), claimInfo());
    await resolveHeldPayout(t.deps, t.relay, 'not-paid');
    expect(t.relay.status).toBe('open');
    expect(t.journal.get(t.relay.coordinate)).toBeUndefined();
  });
});

describe('sweepJournal', () => {
  it('settles a held payout the wallet now reports as paid', async () => {
    const t = setup();
    t.wallet.payResult = 'unknown';
    await approveAndPay(t.deps, bountyInfo(), claimInfo());
    t.wallet.lookupResult = { state: 'settled', preimage: 'pre-hash-1' };
    await sweepJournal(t.deps, async () => structuredClone(t.relay));
    expect(t.relay.status).toBe('paid');
  });

  it('drops a lock that never reached a relay', async () => {
    const t = setup();
    await t.journal.put({
      bountyCoordinate: t.relay.coordinate,
      bountyId: 'b-1',
      claimEventId: 'claim-1',
      claimantPubkey: CLAIMANT,
      amountSats: 21,
      bolt11: 'inv:21000:h',
      paymentHash: 'h',
      walletPubkey: WALLET,
      state: 'locking',
      startedAt: 0,
    });
    await sweepJournal(t.deps, async () => structuredClone(t.relay));
    expect(t.journal.get(t.relay.coordinate)).toBeUndefined();
    expect(t.wallet.payCalls).toHaveLength(0);
  });
});
