import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let repoDir: string;

jest.mock('../test/test-item.util', () => ({
  workspaceRoot: jest.fn(() => repoDir),
}));

import {
  CLAIM_TRAILER_KEY,
  addClaimTrailerToHead,
  claimTrailerToken,
  readCommitPatches,
  hasCommits,
  headHasClaimTrailer,
  verifyClaimTrailer,
} from './claim-trailer.js';

/**
 * These run against a real temporary git repository rather than a mocked
 * `child_process`. The whole point of this module is what git actually says
 * about ancestry and message search — a mocked git would assert our own
 * assumptions back at us and prove nothing.
 */

const BOUNTY_ID = '11111111-1111-4111-8111-111111111111';
const CLAIMANT = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const TOKEN = claimTrailerToken(BOUNTY_ID, CLAIMANT);
const OTHER_TOKEN = claimTrailerToken(BOUNTY_ID, OTHER);

function git(args: string[], cwd = repoDir): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function commit(message: string, file = 'work.txt'): string {
  fs.writeFileSync(path.join(repoDir, file), `${Math.random()}`);
  git(['add', '-A']);
  git(['commit', '-m', message]);
  return git(['rev-parse', 'HEAD']);
}

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sattest-git-'));
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  commit('initial commit');
});

afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
});

describe('claimTrailerToken', () => {
  it('never puts the raw pubkey in the commit message', () => {
    // The whole reason for hashing: a commit message is permanent and, in a
    // public repo, scrapeable into a git-identity ↔ nostr-identity map.
    expect(TOKEN).not.toContain(CLAIMANT);
    expect(CLAIMANT).not.toContain(TOKEN);
    expect(TOKEN).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic, so the creator can recompute it offline', () => {
    // This is what keeps verification local: no backend lookup, so a
    // compromised server can't reassign a commit to a different claimant.
    expect(claimTrailerToken(BOUNTY_ID, CLAIMANT)).toBe(TOKEN);
    expect(claimTrailerToken(BOUNTY_ID, CLAIMANT.toUpperCase())).toBe(TOKEN);
  });

  it('differs per bounty, so one claimant\'s trailers do not correlate', () => {
    const otherBounty = '22222222-2222-4222-8222-222222222222';
    expect(claimTrailerToken(otherBounty, CLAIMANT)).not.toBe(TOKEN);
  });

  it('differs per claimant within the same bounty', () => {
    expect(OTHER_TOKEN).not.toBe(TOKEN);
  });
});

describe('verifyClaimTrailer', () => {
  it('does not match a commit tagged for a different bounty', () => {
    // Same claimant, different bounty — the digest is salted per bounty, so
    // work on bounty A can't be presented as a claim on bounty B.
    const otherBounty = '22222222-2222-4222-8222-222222222222';
    commit(`fix the test\n\n${CLAIM_TRAILER_KEY}: ${claimTrailerToken(otherBounty, CLAIMANT)}`);

    expect(verifyClaimTrailer(BOUNTY_ID, CLAIMANT).evidence).toBe('absent');
    expect(verifyClaimTrailer(otherBounty, CLAIMANT).evidence).toBe('in-history');
  });

  it('reports "absent" when no commit carries the claimant pubkey', () => {
    commit('unrelated work');
    expect(verifyClaimTrailer(BOUNTY_ID, CLAIMANT)).toMatchObject({ evidence: 'absent', commits: [] });
  });

  it('reports "in-history" for a trailer commit reachable from HEAD', () => {
    const sha = commit(`fix the test\n\n${CLAIM_TRAILER_KEY}: ${TOKEN}`);

    const result = verifyClaimTrailer(BOUNTY_ID, CLAIMANT);

    expect(result.evidence).toBe('in-history');
    expect(result.commits.map((c) => c.sha)).toContain(sha);
  });

  it('does not match one claimant against another claimant\'s trailer', () => {
    commit(`fix the test\n\n${CLAIM_TRAILER_KEY}: ${OTHER_TOKEN}`);

    expect(verifyClaimTrailer(BOUNTY_ID, CLAIMANT).evidence).toBe('absent');
    expect(verifyClaimTrailer(BOUNTY_ID, OTHER).evidence).toBe('in-history');
  });

  it('survives a squash-style rewrite, because it matches the message not the SHA', () => {
    // Squash and rebase both change SHAs while preserving the message body —
    // which is exactly why the trailer, not the commit id, is the identifier.
    const original = commit(`fix the test\n\n${CLAIM_TRAILER_KEY}: ${TOKEN}`);
    git(['commit', '--amend', '-m', `squashed fix\n\n${CLAIM_TRAILER_KEY}: ${TOKEN}`]);
    const rewritten = git(['rev-parse', 'HEAD']);

    expect(rewritten).not.toBe(original);
    const result = verifyClaimTrailer(BOUNTY_ID, CLAIMANT);
    expect(result.evidence).toBe('in-history');
    expect(result.commits.map((c) => c.sha)).toContain(rewritten);
  });

  it('reports "elsewhere" for a local branch the creator has but has not merged', () => {
    // Local topic branches count. A maintainer who ran `gh pr checkout 99` has
    // the contributor's commits locally with no remote-tracking ref and no
    // merge — that is real, inspectable work, and calling it "no commit found"
    // would push them toward merging just to satisfy Sattest.
    git(['checkout', '-b', 'feature']);
    const sha = commit(`fix the test\n\n${CLAIM_TRAILER_KEY}: ${TOKEN}`);
    git(['checkout', 'main']);

    const result = verifyClaimTrailer(BOUNTY_ID, CLAIMANT);

    expect(result.evidence).toBe('elsewhere');
    expect(result.commits[0]).toMatchObject({ sha, inHistory: false });
    expect(result.commits[0].refs).toContain('feature');
  });

  it('reports "elsewhere" for a trailer commit on a fetched remote branch', () => {
    // Stand up a second repo and fetch from it, so the commit lands on a
    // remote-tracking ref without being merged into HEAD.
    const originDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sattest-origin-'));
    git(['init', '--initial-branch=main'], originDir);
    git(['config', 'user.email', 'dev@example.com'], originDir);
    git(['config', 'user.name', 'Dev'], originDir);
    git(['config', 'commit.gpgsign', 'false'], originDir);
    fs.writeFileSync(path.join(originDir, 'seed.txt'), 'seed');
    git(['add', '-A'], originDir);
    git(['commit', '-m', 'seed'], originDir);
    git(['checkout', '-b', 'contrib'], originDir);
    fs.writeFileSync(path.join(originDir, 'fix.txt'), 'fix');
    git(['add', '-A'], originDir);
    git(['commit', '-m', `fix the test\n\n${CLAIM_TRAILER_KEY}: ${TOKEN}`], originDir);
    const contribSha = git(['rev-parse', 'HEAD'], originDir);

    git(['remote', 'add', 'origin', originDir]);
    git(['fetch', 'origin']);

    const result = verifyClaimTrailer(BOUNTY_ID, CLAIMANT);
    expect(result.evidence).toBe('elsewhere');
    expect(result.commits.map((c) => c.sha)).toContain(contribSha);

    fs.rmSync(originDir, { recursive: true, force: true });
  });

  // ── Workflow neutrality ────────────────────────────────────────────────
  //
  // Sattest must not assume a fork/PR/merge pipeline. These two describe the
  // shapes real teams actually use, and both have to give the creator the same
  // usable answer without either being treated as the "wrong" way to work.
  describe('across team workflows', () => {
    it('shared feature branch: no PR, no merge, still in the creator\'s history', () => {
      // Creator and claimant both work on the same branch. Nothing is ever
      // merged — the commit is simply there once the creator pulls.
      git(['checkout', '-b', 'feature/checkout']);
      const sha = commit(`fix the refund path\n\n${CLAIM_TRAILER_KEY}: ${TOKEN}`);

      const result = verifyClaimTrailer(BOUNTY_ID, CLAIMANT);

      expect(result.evidence).toBe('in-history');
      expect(result.currentBranch).toBe('feature/checkout');
      expect(result.commits[0]).toMatchObject({
        sha,
        subject: 'fix the refund path',
        inHistory: true,
      });
      expect(result.commits[0].refs).toContain('feature/checkout');
    });

    it('maintainer merges a contributor PR, then approves', () => {
      // The classic flow: contributor's work arrives on a topic branch and is
      // merged into the creator's branch before approval.
      git(['checkout', '-b', 'contrib']);
      const sha = commit(`fix the refund path\n\n${CLAIM_TRAILER_KEY}: ${TOKEN}`);
      git(['checkout', 'main']);
      git(['merge', '--no-ff', 'contrib', '-m', 'merge contrib']);

      const result = verifyClaimTrailer(BOUNTY_ID, CLAIMANT);

      // Identical answer to the shared-branch case — which is the point: the
      // creator's process doesn't change what Sattest can tell them.
      expect(result.evidence).toBe('in-history');
      expect(result.currentBranch).toBe('main');
      expect(result.commits.map((c) => c.sha)).toContain(sha);
    });

    it('surfaces the commit subject so the creator can match it to work they reviewed', () => {
      // The subject is the thing a human actually recognises — a grade like
      // "verified" tells them nothing they can check.
      commit(`make the flaky refund test deterministic\n\n${CLAIM_TRAILER_KEY}: ${TOKEN}`);

      const result = verifyClaimTrailer(BOUNTY_ID, CLAIMANT);

      expect(result.commits[0].subject).toBe('make the flaky refund test deterministic');
    });
  });

  it('reports "unknown" for a malformed pubkey rather than shelling out', () => {
    expect(verifyClaimTrailer(BOUNTY_ID, 'not-a-pubkey').evidence).toBe('unknown');
    expect(verifyClaimTrailer(BOUNTY_ID, '').evidence).toBe('unknown');
  });

  it('does not let a pubkey argument reach a shell', () => {
    // execFileSync takes an argv array, so there is no shell to inject into —
    // and the shape check rejects this long before that matters. If either
    // guard were removed this would create a file or throw.
    const injected = `${'a'.repeat(64)}"; touch /tmp/sattest-pwned; #`;
    expect(verifyClaimTrailer(BOUNTY_ID, injected).evidence).toBe('unknown');
    expect(fs.existsSync('/tmp/sattest-pwned')).toBe(false);
  });

  it('reports "unknown" outside a git repository, never "absent"', () => {
    // "We couldn't check" must not render as "we checked and found nothing" —
    // the creator's decision differs between the two.
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'sattest-norepo-'));
    const previous = repoDir;
    repoDir = notARepo;

    expect(verifyClaimTrailer(BOUNTY_ID, CLAIMANT).evidence).toBe('unknown');

    repoDir = previous;
    fs.rmSync(notARepo, { recursive: true, force: true });
  });
});

describe('addClaimTrailerToHead', () => {
  it('appends the trailer to the latest commit', () => {
    commit('fix the test');

    const sha = addClaimTrailerToHead(BOUNTY_ID, CLAIMANT);

    expect(git(['log', '-1', '--format=%B'])).toContain(`${CLAIM_TRAILER_KEY}: ${TOKEN}`);
    expect(sha).toBe(git(['rev-parse', 'HEAD']));
    // And it is immediately verifiable — the two halves have to agree.
    expect(verifyClaimTrailer(BOUNTY_ID, CLAIMANT).evidence).toBe('in-history');
  });

  it('preserves the original commit subject', () => {
    commit('fix the refund path');
    addClaimTrailerToHead(BOUNTY_ID, CLAIMANT);
    expect(git(['log', '-1', '--format=%s'])).toBe('fix the refund path');
  });

  it('refuses a malformed pubkey', () => {
    commit('fix the test');
    expect(() => addClaimTrailerToHead(BOUNTY_ID, 'nope')).toThrow(/malformed pubkey/i);
  });
});

describe('headHasClaimTrailer', () => {
  it('is false before tagging and true after', () => {
    commit('fix the test');
    expect(headHasClaimTrailer(BOUNTY_ID, CLAIMANT)).toBe(false);

    addClaimTrailerToHead(BOUNTY_ID, CLAIMANT);

    expect(headHasClaimTrailer(BOUNTY_ID, CLAIMANT)).toBe(true);
    expect(headHasClaimTrailer(BOUNTY_ID, OTHER)).toBe(false);
  });
});

describe('readCommitPatches', () => {
  it('returns the actual changed lines, so the creator reviews code not a subject line', () => {
    fs.writeFileSync(path.join(repoDir, 'refund.ts'), 'export const refund = () => 42;\n');
    git(['add', '-A']);
    git(['commit', '-m', `fix the refund path\n\n${CLAIM_TRAILER_KEY}: ${TOKEN}`]);
    const sha = git(['rev-parse', 'HEAD']);

    const patch = readCommitPatches([sha]);

    expect(patch).toContain('fix the refund path');
    expect(patch).toContain('refund.ts');
    expect(patch).toContain('+export const refund = () => 42;');
  });

  it('concatenates every commit in the claim', () => {
    const first = commit(`first fix\n\n${CLAIM_TRAILER_KEY}: ${TOKEN}`, 'a.txt');
    const second = commit(`second fix\n\n${CLAIM_TRAILER_KEY}: ${TOKEN}`, 'b.txt');

    const patch = readCommitPatches([first, second]);

    expect(patch).toContain('first fix');
    expect(patch).toContain('second fix');
  });

  it('degrades to a note rather than throwing on an unreadable commit', () => {
    expect(readCommitPatches(['0'.repeat(40)])).toContain('Could not read commit');
  });

  it('returns empty for no commits', () => {
    expect(readCommitPatches([])).toBe('');
  });
});

describe('hasCommits', () => {
  it('is true for a repo with a commit', () => {
    expect(hasCommits()).toBe(true);
  });

  it('is false for a freshly initialised repo', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sattest-empty-'));
    git(['init', '--initial-branch=main'], empty);
    const previous = repoDir;
    repoDir = empty;

    expect(hasCommits()).toBe(false);

    repoDir = previous;
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
