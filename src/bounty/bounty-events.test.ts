import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { Event, EventTemplate } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import {
  assembleBounties,
  buildAnnouncement,
  buildBountyEvent,
  buildClaimEvent,
  decryptClaimLnurl,
  latestVersions,
  mineClaimPow,
  nextCreatedAt,
  parseBountyEvent,
  parseClaimEvent,
} from './bounty-events.js';
import { deriveRepoIdentity } from '../git/repo-identity.js';
import { BOUNTY_KIND, coordinate } from '../api/nostr-protocol.js';

const repo = deriveRepoIdentity('1111111111111111111111111111111111111111');
const otherRepo = deriveRepoIdentity('2222222222222222222222222222222222222222');

const creatorSk = generateSecretKey();
const creator = getPublicKey(creatorSk);
const claimantSk = generateSecretKey();
const claimant = getPublicKey(claimantSk);
const strangerSk = generateSecretKey();

// Low difficulty keeps the suite fast; the production minimum is pinned in the
// contract test.
const POW = 4;

const sign = (t: EventTemplate, sk: Uint8Array) => finalizeEvent(t, sk);

function bounty(
  status: 'open' | 'approving' | 'paid' | 'cancelled' = 'open',
  extra: Partial<Parameters<typeof buildBountyEvent>[0]> = {}
): Event {
  return sign(
    buildBountyEvent({
      id: 'b-1',
      repoId: repo.repoId,
      repoKey: repo.repoKey,
      content: { testId: '/src/a.test.ts#adds', testLabel: 'adds', amountSats: 2100 },
      status,
      now: 1_000,
      ...extra,
    }),
    extra.repoKey === otherRepo.repoKey ? creatorSk : creatorSk
  );
}

function claim(sk = claimantSk, extra: Partial<Parameters<typeof buildClaimEvent>[0]> = {}) {
  const template = buildClaimEvent({
    bountyCoordinate: coordinate(BOUNTY_KIND, creator, 'b-1'),
    repoId: repo.repoId,
    lnurl: 'alice@example.com',
    now: 1_100,
    ...extra,
  });
  return sign(mineClaimPow(template, getPublicKey(sk), POW), sk);
}

describe('bounty events', () => {
  it('round-trips a bounty and keeps its details encrypted', () => {
    const event = bounty();
    expect(event.content).not.toContain('adds');
    expect(event.content).not.toContain('2100');
    const parsed = parseBountyEvent(event, repo.repoKey, repo.repoId);
    expect(parsed).toMatchObject({
      id: 'b-1',
      creator,
      status: 'open',
      content: { testId: '/src/a.test.ts#adds', amountSats: 2100 },
    });
  });

  it('cannot be read without the repository key', () => {
    expect(parseBountyEvent(bounty(), otherRepo.repoKey)).toBeUndefined();
  });

  it('rejects a forged signature', () => {
    const event = { ...bounty(), sig: '0'.repeat(128) };
    expect(parseBountyEvent(event, repo.repoKey)).toBeUndefined();
  });

  it('rejects out-of-range amounts', () => {
    expect(() =>
      buildBountyEvent({
        id: 'x',
        repoId: repo.repoId,
        repoKey: repo.repoKey,
        content: { testId: 't', amountSats: 50_001 },
        status: 'open',
      })
    ).toThrow();
    // A hand-built event with a bad amount is ignored on read.
    const bad = sign(
      {
        kind: BOUNTY_KIND,
        created_at: 1,
        tags: [['d', 'x'], ['r', repo.repoId], ['status', 'open']],
        content: nip44.encrypt(JSON.stringify({ v: 1, testId: 't', amountSats: 0 }), repo.repoKey),
      },
      creatorSk
    );
    expect(parseBountyEvent(bad, repo.repoKey)).toBeUndefined();
  });

  it('carries the payout receipt on a paid bounty', () => {
    const event = bounty('paid', {
      payout: {
        claimEventId: 'e'.repeat(64),
        claimantPubkey: claimant,
        paymentHash: 'a'.repeat(64),
        preimage: 'b'.repeat(64),
        paidAt: 1_200,
      },
    });
    expect(parseBountyEvent(event, repo.repoKey)?.payout).toEqual({
      claimEventId: 'e'.repeat(64),
      claimantPubkey: claimant,
      paymentHash: 'a'.repeat(64),
      preimage: 'b'.repeat(64),
      paidAt: 1_200,
      resolution: undefined,
    });
  });

  it('never moves created_at backwards', () => {
    expect(nextCreatedAt(undefined, 100)).toBe(100);
    expect(nextCreatedAt(50, 100)).toBe(100);
    expect(nextCreatedAt(150, 100)).toBe(151);
  });
});

describe('claim events', () => {
  it('encrypts the payout address so only the creator can read it', async () => {
    const event = claim();
    expect(event.content).not.toContain('alice');
    const parsed = parseClaimEvent(event, { minPow: POW })!;
    expect(parsed).toMatchObject({ claimant, creator, bountyId: 'b-1', status: 'pending' });

    const creatorDecrypt = async (sender: string, ct: string) =>
      nip44.decrypt(ct, nip44.getConversationKey(creatorSk, sender));
    expect(
      await decryptClaimLnurl(
        { encryptedLnurl: event.content, ephemeralPubkey: parsed.ephemeralPubkey },
        creatorDecrypt
      )
    ).toBe('alice@example.com');

    const strangerDecrypt = async (sender: string, ct: string) =>
      nip44.decrypt(ct, nip44.getConversationKey(strangerSk, sender));
    await expect(
      decryptClaimLnurl(
        { encryptedLnurl: event.content, ephemeralPubkey: parsed.ephemeralPubkey },
        strangerDecrypt
      )
    ).rejects.toThrow();
  });

  it('requires proof of work', () => {
    const unmined = sign(
      buildClaimEvent({
        bountyCoordinate: coordinate(BOUNTY_KIND, creator, 'b-1'),
        repoId: repo.repoId,
        lnurl: 'a@b.co',
      }),
      claimantSk
    );
    expect(parseClaimEvent(unmined, { minPow: 30 })).toBeUndefined();
    expect(parseClaimEvent(claim(), { minPow: POW })).toBeDefined();
  });

  it('records public-announcement consent only when given', () => {
    expect(parseClaimEvent(claim(), { minPow: POW })?.publicConsent).toBe(false);
    expect(
      parseClaimEvent(claim(claimantSk, { publicConsent: true }), { minPow: POW })?.publicConsent
    ).toBe(true);
  });
});

describe('latestVersions', () => {
  it('keeps the newest version per coordinate, breaking ties by lowest id', () => {
    const v1 = bounty('open', { now: 100 });
    const v2 = bounty('cancelled', { now: 200 });
    expect(latestVersions([v2, v1])).toEqual([v2]);

    const a = bounty('open', { now: 300 });
    const b = bounty('cancelled', { now: 300 });
    const winner = a.id < b.id ? a : b;
    expect(latestVersions([a, b])).toEqual([winner]);
    expect(latestVersions([b, a])).toEqual([winner]);
  });
});

describe('assembleBounties', () => {
  const opts = { minClaimPow: POW };

  it('builds the UI model with pending claims', () => {
    const [b] = assembleBounties([bounty(), claim()], repo.repoKey, repo.repoId, opts);
    expect(b).toMatchObject({ id: 'b-1', amountSats: 2100, active: true, creatorId: creator });
    expect(b.claims).toHaveLength(1);
    expect(b.claims[0]).toMatchObject({ claimantPubkey: claimant, status: 'pending' });
  });

  it('marks the paid claim approved and the bounty inactive', () => {
    const c = claim();
    const paid = bounty('paid', {
      now: 1_500,
      payout: { claimEventId: c.id, claimantPubkey: claimant, paymentHash: 'a'.repeat(64) },
    });
    const [b] = assembleBounties([bounty(), paid, c], repo.repoKey, repo.repoId, opts);
    expect(b.active).toBe(false);
    expect(b.claims[0].status).toBe('approved');
  });

  it('ignores a status published by anyone but the creator', () => {
    // The Sattest project account (or any other key) cannot change a bounty:
    // its "version" is a different coordinate and never matches a claim.
    const forged = sign(
      buildBountyEvent({
        id: 'b-1',
        repoId: repo.repoId,
        repoKey: repo.repoKey,
        content: { testId: '/src/a.test.ts#adds', amountSats: 2100 },
        status: 'paid',
        now: 5_000,
      }),
      strangerSk
    );
    const result = assembleBounties([bounty(), forged, claim()], repo.repoKey, repo.repoId, opts);
    const real = result.find((b) => b.creatorId === creator)!;
    expect(real.status).toBe('open');
    expect(real.claims).toHaveLength(1);
    const fake = result.find((b) => b.creatorId !== creator)!;
    expect(fake.claims).toHaveLength(0);
  });

  it('drops withdrawn claims and other repositories', () => {
    const withdrawn = claim(claimantSk, { status: 'withdrawn', now: 1_200 });
    const [b] = assembleBounties([bounty(), claim(), withdrawn], repo.repoKey, repo.repoId, opts);
    expect(b.claims).toHaveLength(0);
    expect(assembleBounties([bounty()], otherRepo.repoKey, otherRepo.repoId, opts)).toEqual([]);
  });
});

describe('buildAnnouncement', () => {
  it('tags the Sattest account and, for payouts, the claimant', () => {
    const t = buildAnnouncement({
      kind: 'payout',
      bountyCoordinate: 'c',
      amountSats: 10,
      testLabel: 'adds',
      sattestPubkey: 'f'.repeat(64),
      claimantPubkey: claimant,
    });
    expect(t.kind).toBe(1);
    expect(t.tags).toEqual(
      expect.arrayContaining([
        ['p', 'f'.repeat(64)],
        ['p', claimant],
        ['sattest-announce', 'payout'],
      ])
    );
  });
});
