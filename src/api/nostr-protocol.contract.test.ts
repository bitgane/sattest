import {
  BOUNTY_KIND,
  CLAIM_KIND,
  ANNOUNCEMENT_KIND,
  MIN_CLAIM_POW,
  MAX_BOUNTY_SATS,
  MIN_BOUNTY_SATS,
  REQUESTED_SIGNER_PERMS,
  TAG,
  coordinate,
  parseCoordinate,
  SATTEST_ACCOUNT,
  normalizeAccountKey,
  sattestAccountPubkey,
  announcementsEnabled,
} from './nostr-protocol.js';

/**
 * Wire-contract pins for Sattest's Nostr protocol.
 *
 * There is no server: every client reads every other client's events,
 * so these values ARE the shared schema. The literals are hardcoded on purpose —
 * comparing a constant to itself proves nothing. Changing one here is a
 * protocol change and must be reflected in docs/nostr-protocol.md.
 */
describe('Sattest Nostr wire contract', () => {
  it('pins the event kinds', () => {
    expect(BOUNTY_KIND).toBe(37400);
    expect(CLAIM_KIND).toBe(37401);
    expect(ANNOUNCEMENT_KIND).toBe(1);
  });

  it('uses addressable kinds for bounty state', () => {
    for (const kind of [BOUNTY_KIND, CLAIM_KIND]) {
      expect(kind).toBeGreaterThanOrEqual(30000);
      expect(kind).toBeLessThan(40000);
    }
  });

  it('pins the tag names', () => {
    expect(TAG).toMatchObject({
      identifier: 'd',
      repo: 'r',
      address: 'a',
      event: 'e',
      pubkey: 'p',
      status: 'status',
      paymentHash: 'payment_hash',
      preimage: 'preimage',
      ephemeralKey: 'epk',
      publicConsent: 'public',
    });
  });

  it('pins the validation bounds', () => {
    expect(MIN_BOUNTY_SATS).toBe(1);
    expect(MAX_BOUNTY_SATS).toBe(50_000);
    expect(MIN_CLAIM_POW).toBe(16);
  });

  it('requests signing rights for every kind the extension publishes', () => {
    // Without these the signer prompts on background signatures the user never
    // sees, and the action just hangs.
    expect(REQUESTED_SIGNER_PERMS).toEqual(
      expect.arrayContaining([
        'get_public_key',
        'sign_event:37400',
        'sign_event:37401',
        'sign_event:1',
        'nip44_decrypt',
      ])
    );
  });

  it('round-trips coordinates and rejects malformed ones', () => {
    const pk = 'a'.repeat(64);
    expect(parseCoordinate(coordinate(37400, pk, 'abc-123'))).toEqual({
      kind: 37400,
      pubkey: pk,
      d: 'abc-123',
    });
    expect(parseCoordinate('37400:nothex:abc')).toBeUndefined();
    expect(parseCoordinate('37400:' + pk)).toBeUndefined();
  });

  it('configures the Sattest account by its public key, used as hex in p tags', () => {
    expect(SATTEST_ACCOUNT).toBe('npub17789nud60ecdnj4vx8sap65px0heeknll7zxfsjf082mkskv6kdq70hq5t');
    expect(sattestAccountPubkey()).toBe(
      'f78e59f1ba7e70d9caac31e1d0ea8133ef9cda7fff8464c24979d5bb42ccd59a'
    );
    expect(announcementsEnabled()).toBe(true);
  });
});

describe('normalizeAccountKey', () => {
  it('accepts an npub or 64-hex and returns lowercase hex', () => {
    expect(
      normalizeAccountKey(' npub17789nud60ecdnj4vx8sap65px0heeknll7zxfsjf082mkskv6kdq70hq5t ')
    ).toBe('f78e59f1ba7e70d9caac31e1d0ea8133ef9cda7fff8464c24979d5bb42ccd59a');
    expect(
      normalizeAccountKey(
        'f78e59f1ba7e70d9caac31e1d0ea8133ef9cda7fff8464c24979d5bb42ccd59a'.toUpperCase()
      )
    ).toBe('f78e59f1ba7e70d9caac31e1d0ea8133ef9cda7fff8464c24979d5bb42ccd59a');
  });

  it('turns announcements off for empty, malformed or private keys', () => {
    expect(normalizeAccountKey('')).toBeUndefined();
    expect(normalizeAccountKey('npub1notavalidkey')).toBeUndefined();
    // Built, not pasted: never commit anything that looks like a real private key.
    expect(normalizeAccountKey(`nsec1${'q'.repeat(58)}`)).toBeUndefined();
    expect(normalizeAccountKey('abc123')).toBeUndefined();
  });
});
