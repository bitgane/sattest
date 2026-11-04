import { execFile } from 'child_process';
import {
  _resetRepoIdentityForTests,
  deriveRepoIdentity,
  describeRepoIdentityFailure,
  getRepoIdentity,
  pickRootCommit,
} from './repo-identity.js';

jest.mock('child_process', () => ({ execFile: jest.fn() }));

const ROOT_A = '1111111111111111111111111111111111111111';
const ROOT_B = '0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** A git failure: the exec error plus what git wrote to stderr. */
class GitFailure {
  constructor(
    public readonly stderr: string,
    public readonly killed = false
  ) {}
}

type GitAnswers = Record<string, string | Error | GitFailure>;

/** Answers for a healthy, full clone whose root is ROOT_A. */
const HEALTHY: GitAnswers = {
  'rev-parse --git-dir': '.git',
  'rev-parse --verify --quiet HEAD': ROOT_A,
  'rev-parse --is-shallow-repository': 'false',
  'rev-list --max-parents=0 HEAD': `${ROOT_A}\n`,
};

function mockGit(answers: GitAnswers) {
  (execFile as unknown as jest.Mock).mockImplementation(
    (
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb: (e: Error | null, out: string, err: string) => void
    ) => {
      const key = args.join(' ');
      const answer = answers[key];
      if (answer instanceof GitFailure) {
        cb(Object.assign(new Error('Command failed'), { killed: answer.killed }), '', answer.stderr);
      } else if (answer instanceof Error) {
        cb(answer, '', '');
      } else if (answer === undefined) {
        cb(new Error(`unexpected git ${key}`), '', '');
      } else {
        cb(null, answer, '');
      }
    }
  );
}

const callsFor = (key: string) =>
  (execFile as unknown as jest.Mock).mock.calls.filter((c) => (c[1] as string[]).join(' ') === key);

beforeEach(() => {
  _resetRepoIdentityForTests();
  (execFile as unknown as jest.Mock).mockReset();
});

describe('deriveRepoIdentity', () => {
  it('is deterministic and pins its derivation', () => {
    const a = deriveRepoIdentity(ROOT_A);
    const b = deriveRepoIdentity(ROOT_A.toUpperCase());
    expect(a.repoId).toBe(b.repoId);
    expect(Buffer.from(a.repoKey).toString('hex')).toBe(Buffer.from(b.repoKey).toString('hex'));
    // Pinned vectors: a change here re-scopes every bounty on the network.
    expect(a.repoId).toMatchInlineSnapshot(
      `"5983d50387d59a2262d00f1036375ef4301965eddcd6081f10f622470a254b00"`
    );
    expect(a.repoKey).toHaveLength(32);
  });

  it('keeps the public id independent of the content key', () => {
    const { repoId, repoKey } = deriveRepoIdentity(ROOT_A);
    expect(repoId).not.toBe(Buffer.from(repoKey).toString('hex'));
    expect(repoId).not.toContain(ROOT_A);
  });

  it('gives different repositories different ids', () => {
    expect(deriveRepoIdentity(ROOT_A).repoId).not.toBe(deriveRepoIdentity(ROOT_B).repoId);
  });

  it('rejects anything that is not an object id', () => {
    expect(() => deriveRepoIdentity('main')).toThrow();
  });
});

describe('pickRootCommit', () => {
  it('picks the smallest root so every clone agrees', () => {
    expect(pickRootCommit(`${ROOT_A}\n${ROOT_B}\n`)).toBe(ROOT_B);
  });

  it('ignores junk lines', () => {
    expect(pickRootCommit('warning: x\n')).toBeUndefined();
  });
});

describe('getRepoIdentity', () => {
  it('derives the identity from the root commit', async () => {
    mockGit(HEALTHY);
    const result = await getRepoIdentity();
    expect(result).toMatchObject({
      ok: true,
      rootSha: ROOT_A,
      repoId: deriveRepoIdentity(ROOT_A).repoId,
    });
  });

  it('refuses a shallow clone, whose root would be wrong', async () => {
    mockGit({ ...HEALTHY, 'rev-parse --is-shallow-repository': 'true' });
    expect(await getRepoIdentity()).toEqual({ ok: false, reason: 'shallow' });
  });

  it('reports a folder that is not a git repository', async () => {
    mockGit({ 'rev-parse --git-dir': new GitFailure('fatal: not a git repository') });
    expect(await getRepoIdentity()).toEqual({ ok: false, reason: 'not-git' });
  });

  it('reports "no commits" only when HEAD really is unborn', async () => {
    mockGit({ ...HEALTHY, 'rev-parse --verify --quiet HEAD': new GitFailure('') });
    expect(await getRepoIdentity()).toEqual({ ok: false, reason: 'no-commits' });
  });

  it('reports any other git failure as a git error, with git\'s own message', async () => {
    // HEAD exists, but reading the history fails — this used to be reported as
    // "no commits yet", which sent users chasing the wrong problem.
    mockGit({
      ...HEALTHY,
      'rev-list --max-parents=0 HEAD': new GitFailure('fatal: unable to read tree 1234abcd'),
    });
    const result = await getRepoIdentity();
    expect(result).toEqual({
      ok: false,
      reason: 'git-error',
      detail: 'fatal: unable to read tree 1234abcd',
    });
    if (!result.ok) {
      const message = describeRepoIdentityFailure(result.reason, result.detail);
      expect(message).toContain('fatal: unable to read tree 1234abcd');
      expect(message).not.toContain('no commits');
    }
  });

  it('reports a history walk that times out', async () => {
    mockGit({ ...HEALTHY, 'rev-list --max-parents=0 HEAD': new GitFailure('', true) });
    expect(await getRepoIdentity()).toEqual({
      ok: false,
      reason: 'git-error',
      detail: 'git took too long to read the repository history',
    });
  });

  it('gives the history walk a longer timeout than the quick lookups', async () => {
    mockGit(HEALTHY);
    await getRepoIdentity();
    const [revList] = callsFor('rev-list --max-parents=0 HEAD');
    const [gitDir] = callsFor('rev-parse --git-dir');
    expect(revList[2].timeout).toBeGreaterThan(gitDir[2].timeout);
  });

  it('caches success and shares one lookup between concurrent callers', async () => {
    mockGit(HEALTHY);
    await Promise.all([getRepoIdentity(), getRepoIdentity()]);
    await getRepoIdentity();
    expect(callsFor('rev-list --max-parents=0 HEAD')).toHaveLength(1);
  });

  it('does not cache a failure — the first commit is picked up without a reload', async () => {
    mockGit({ ...HEALTHY, 'rev-parse --verify --quiet HEAD': new GitFailure('') });
    expect(await getRepoIdentity()).toEqual({ ok: false, reason: 'no-commits' });

    // The user commits something; the next call must see it.
    mockGit(HEALTHY);
    expect(await getRepoIdentity()).toMatchObject({ ok: true, rootSha: ROOT_A });
  });
});
