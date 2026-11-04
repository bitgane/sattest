import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { EventTemplate } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import { BountyStore } from './bounty-store.js';
import { RelayClient } from '../nostr/relay-client.js';
import { deriveRepoIdentity } from '../git/repo-identity.js';
import { NwcClient } from '../lightning/nwc-client.js';
import { FakeWallet, MemoryPool, makePaymentPair } from '../testing/memory-relay.js';
import type { KeyValueStore } from '../lightning/payout.js';
import { BOUNTY_KIND, CLAIM_KIND } from '../api/nostr-protocol.js';

/**
 * End to end, with no server anywhere: a creator and a claimant, each with
 * their own store and keys, sharing only a relay network — plus the creator's
 * wallet service on that network. Signatures, encryption, proof of work and
 * the NIP-47 exchange are all real; only the bolt11 format is simplified
 * ("inv:<msat>:<hash>"), because minting signed invoices needs a node.
 */

jest.mock('../lightning/bolt11.js', () => ({
  decodeInvoice: (s: string) => {
    const [, msat, hash] = s.split(':');
    if (!hash) {
      throw new Error('not an invoice');
    }
    return { amountMsat: Number(msat), paymentHash: hash, timestamp: 0, expirySeconds: 3600 };
  },
  paymentHashFromBolt11: (s: string) => s.split(':')[2],
}));

// Not reached — signing and decryption are injected — but bounty-store imports
// it, and its real module pulls in the VS Code-bound signer UI.
jest.mock('../api/user-signer', () => ({ signUserEvent: jest.fn(), decryptForUser: jest.fn() }));

const POW = 4;
const repo = deriveRepoIdentity('1111111111111111111111111111111111111111');

function memoryStore(): KeyValueStore {
  const data = new Map<string, unknown>();
  return {
    get: <T>(k: string) => data.get(k) as T | undefined,
    update: async (k: string, v: unknown) => {
      data.set(k, v);
    },
  };
}

function participant(
  pool: MemoryPool,
  opts: { wallet?: FakeWallet; payReplyTimeoutMs?: number } = {}
) {
  // Generous by default so a slow machine never turns a real reply into a
  // "no reply"; only the test that needs the timeout to fire shortens it.
  const payReplyTimeoutMs = opts.payReplyTimeoutMs ?? 10_000;
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  const relays = new RelayClient(() => ['wss://relay.test'], { pool, store: memoryStore() });
  const store = new BountyStore({
    relays,
    identity: async () => repo,
    sign: async (t: EventTemplate) => finalizeEvent(t, sk),
    decrypt: async (sender, ct) => nip44.decrypt(ct, nip44.getConversationKey(sk, sender)),
    openWallet: async () =>
      opts.wallet ? new NwcClient(opts.wallet.uri, { pool, payReplyTimeoutMs }) : undefined,
    journalStore: memoryStore(),
    fetchInvoice: async (_lnurl, msat) => {
      const pair = makePaymentPair();
      opts.wallet?.preimages.set(pair.paymentHash, pair.preimage);
      return `inv:${msat}:${pair.paymentHash}`;
    },
    minClaimPow: POW,
    settleMs: 0,
    workspaceRoot: () => '/ws',
    sattestPubkey: 'f'.repeat(64),
  });
  return { sk, pubkey, store };
}

describe('bounty lifecycle over relays (no server)', () => {
  let pool: MemoryPool;
  let wallet: FakeWallet;

  beforeEach(() => {
    pool = new MemoryPool();
    wallet = new FakeWallet(pool);
    wallet.hashOf = (s) => s.split(':')[2];
  });

  afterEach(() => {
    wallet.stop();
    pool.close();
  });

  async function createAndClaim(creatorOpts: { payReplyTimeoutMs?: number } = {}) {
    const creator = participant(pool, { wallet, ...creatorOpts });
    const claimant = participant(pool);

    const created = await creator.store.createBounty({
      amountSats: 21,
      testId: '/ws/src/math.test.ts#adds',
      testLabel: 'adds',
      repoSlug: 'acme/secret',
    });
    expect(created).toMatchObject({ amountSats: 21, status: 'open', testId: '/ws/src/math.test.ts#adds' });

    const [seen] = await claimant.store.fetchBounties();
    expect(seen).toMatchObject({ id: created.id, creatorId: creator.pubkey, amountSats: 21 });

    const claim = await claimant.store.claimBounty(seen, 'alice@example.com', {
      claimantPubkey: claimant.pubkey,
    });
    return { creator, claimant, created, claim };
  }

  it('creates, claims, approves and pays — with a verifiable receipt', async () => {
    const { creator, claimant, claim } = await createAndClaim();

    const [bounty] = await creator.store.fetchBounties();
    const [pending] = await creator.store.getPendingClaims(bounty);
    expect(pending).toMatchObject({ id: claim.id, claimantPubkey: claimant.pubkey });
    await expect(creator.store.readClaimPayoutAddress(pending)).resolves.toBe('alice@example.com');

    const result = await creator.store.approveClaim(bounty, pending);
    expect(typeof result).toBe('object');
    expect(wallet.requests.filter((r) => r.method === 'pay_invoice')).toHaveLength(1);

    // Anyone can read the outcome — and check the proof of payment.
    const [paid] = await claimant.store.fetchBounties({ includeInactive: true });
    expect(paid.status).toBe('paid');
    expect(paid.active).toBe(false);
    expect(paid.claims[0]).toMatchObject({ claimantPubkey: claimant.pubkey, status: 'approved' });
    const { createHash } = await import('crypto');
    expect(
      createHash('sha256').update(Buffer.from(paid.payout!.preimage!, 'hex')).digest('hex')
    ).toBe(paid.payout!.paymentHash);
  });

  it('never publishes bounty details or the payout address in the clear', async () => {
    await createAndClaim();
    const everything = JSON.stringify(pool.events);
    for (const secret of ['adds', 'math.test.ts', 'acme/secret', 'alice@example.com', '"amountSats"']) {
      expect(everything).not.toContain(secret);
    }
    // Only the public repository id is visible, not the root commit.
    expect(everything).toContain(repo.repoId);
    expect(everything).not.toContain(repo.rootSha);
  });

  it('does not pay twice when the creator approves again', async () => {
    const { creator } = await createAndClaim();
    const [bounty] = await creator.store.fetchBounties();
    const [pending] = await creator.store.getPendingClaims(bounty);
    await creator.store.approveClaim(bounty, pending);
    await expect(creator.store.approveClaim(bounty, pending)).resolves.toBe('already-approved');
    expect(wallet.requests.filter((r) => r.method === 'pay_invoice')).toHaveLength(1);
  });

  it('holds a payout whose outcome is unknown, then settles it without paying again', async () => {
    // The wallet below never answers, so a short budget only makes this fast.
    const { creator } = await createAndClaim({ payReplyTimeoutMs: 300 });
    const [bounty] = await creator.store.fetchBounties();
    const [pending] = await creator.store.getPendingClaims(bounty);

    // The wallet pays but its reply never arrives.
    wallet.behavior = 'pay-silently';
    await expect(creator.store.approveClaim(bounty, pending)).resolves.toBe('outcome-unknown');
    const [held] = await creator.store.fetchBounties();
    expect(held.status).toBe('approving');

    // Approving again asks the wallet, which confirms the payment settled.
    wallet.behavior = 'pay';
    await expect(creator.store.approveClaim(held, pending)).resolves.toBe('already-approved');
    expect(wallet.requests.filter((r) => r.method === 'pay_invoice')).toHaveLength(1);
    const [done] = await creator.store.fetchBounties({ includeInactive: true });
    expect(done.status).toBe('paid');
  });

  it('explains a "wallet not found" refusal and leaves the bounty payable', async () => {
    const vscode = await import('vscode');
    const { creator } = await createAndClaim();
    const [bounty] = await creator.store.fetchBounties();
    const [pending] = await creator.store.getPendingClaims(bounty);

    wallet.behavior = 'decline-not-found';
    (vscode.window.showErrorMessage as jest.Mock).mockClear();
    await expect(creator.store.approveClaim(bounty, pending)).resolves.toBeNull();
    const [message] = (vscode.window.showErrorMessage as jest.Mock).mock.calls.at(-1)!;
    expect(message).toContain('"Payment failed: Wallet not found"');
    expect(message).toContain('alice@example.com');
    expect(message).toContain('Nothing was sent');

    const [after] = await creator.store.fetchBounties();
    expect(after.status).toBe('open');

    // Once the claimant's wallet can receive, the same claim pays normally.
    wallet.behavior = 'pay';
    await expect(creator.store.approveClaim(after, pending)).resolves.toMatchObject({ status: 'paid' });
  });

  it('cancels a bounty so it disappears for everyone', async () => {
    const { creator, claimant } = await createAndClaim();
    const [bounty] = await creator.store.fetchBounties();
    await expect(creator.store.deactivateBounty(bounty)).resolves.toBe(true);
    await expect(claimant.store.fetchBounties()).resolves.toEqual([]);
  });

  it('ignores a forged "paid" status from anyone but the creator', async () => {
    const { claimant } = await createAndClaim();
    const attacker = participant(pool);
    const [bounty] = await claimant.store.fetchBounties();
    // The attacker copies the bounty and marks it paid under their own key.
    const forged = finalizeEvent(
      {
        kind: BOUNTY_KIND,
        created_at: bounty.eventCreatedAt + 100,
        tags: [
          ['d', bounty.id],
          ['r', repo.repoId],
          ['status', 'paid'],
        ],
        content: pool.events.find((e) => e.kind === BOUNTY_KIND)!.content,
      },
      attacker.sk
    );
    pool.store(forged);
    const list = await claimant.store.fetchBounties({ includeInactive: true });
    const real = list.find((b) => b.creatorId === bounty.creatorId)!;
    expect(real.status).toBe('open');
    expect(real.claims).toHaveLength(1);
  });

  it('only publishes a public announcement when asked', async () => {
    const { creator } = await createAndClaim();
    const kind1 = () => pool.events.filter((e) => e.kind === 1);
    expect(kind1()).toHaveLength(0);
    const [bounty] = await creator.store.fetchBounties();
    await creator.store.announce(bounty, 'bounty');
    expect(kind1()).toHaveLength(1);
    expect(kind1()[0].tags).toEqual(expect.arrayContaining([['p', 'f'.repeat(64)]]));
    expect(pool.events.filter((e) => e.kind === CLAIM_KIND)).toHaveLength(1);
  });
});
