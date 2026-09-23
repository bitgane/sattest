import {
  NOSTR_AUTH_KIND,
  READ_AUTH_CONTENT,
  WRITE_AUTH_CONTENT,
  REQUESTED_SIGNER_PERMS,
} from './nostr-protocol.js';

/**
 * Wire-contract pins for the Nostr auth protocol.
 *
 * Mirror of `sattest-backend/src/middleware/auth.contract.test.ts`. The two
 * repos share no package, so these constants are defined twice and were kept in
 * sync by a comment alone. A one-sided edit doesn't fail loudly — it makes every
 * money-moving call 401 against a backend that no longer recognises the
 * credential.
 *
 * The literals are hardcoded on purpose: comparing a constant to itself proves
 * nothing. Changing a value forces an edit here, which is the prompt to change
 * the other repo in the same breath.
 */
describe('Nostr auth wire contract (mirrored in the backend repo)', () => {
  it('pins the NIP-42 auth event kind', () => {
    expect(NOSTR_AUTH_KIND).toBe(22242);
  });

  it('pins the read-scope challenge string', () => {
    expect(READ_AUTH_CONTENT).toBe('sattest-auth');
  });

  it('pins the write-scope challenge string', () => {
    expect(WRITE_AUTH_CONTENT).toBe('sattest-auth:write');
  });

  it('keeps the two scopes distinct', () => {
    // A read credential must never satisfy the backend's moneyAuth.
    expect(READ_AUTH_CONTENT).not.toBe(WRITE_AUTH_CONTENT);
  });

  it('requests signing rights for the auth kind at pairing time', () => {
    // Without this perm the signer prompts on every background write-credential
    // signature — a prompt the user never sees, so the payout just hangs.
    expect(REQUESTED_SIGNER_PERMS).toContain(`sign_event:${NOSTR_AUTH_KIND}`);
    expect(REQUESTED_SIGNER_PERMS).toContain('get_public_key');
  });
});
