import { execFile } from 'child_process';
import { hkdfSync } from 'crypto';
import { workspaceRoot } from '../test/test-item.util.js';

/**
 * Repository identity for bounty scoping and encryption.
 *
 * Bounties used to be scoped by the `owner/repo` slug of the `origin` remote,
 * which a central server matched. Without a server, the scope has to be
 * something every clone of the project can compute on its own — and, since
 * relays are public, something that also yields a key only people with the
 * code can derive. The repository's root commit does both:
 *
 *  - every clone and every fork shares it (forks see upstream bounties, which
 *    the origin-slug scheme missed), and it doesn't depend on any host;
 *  - for a private repository it is unknown to outsiders, so a key derived
 *    from it hides bounty details from anyone reading the relays.
 *
 * Two values are derived with HKDF-SHA256 under distinct `info` labels, so the
 * public `repoId` (published as the relay-indexed `r` tag) reveals nothing
 * about `repoKey` (used to encrypt bounty content):
 *
 *   repoId  = HKDF(ikm = rootSha, salt = "sattest:v1", info = "repo-id")
 *   repoKey = HKDF(ikm = rootSha, salt = "sattest:v1", info = "repo-key")
 *
 * Limits, stated honestly: the key hides content from the public, not from
 * anyone who has ever had a copy of the repository. For a public repository
 * the root commit is public, so its bounties are effectively readable by all.
 */

const HKDF_SALT = 'sattest:v1';
const GIT_TIMEOUT_MS = 10_000;
/**
 * `rev-list --max-parents=0` walks the whole history, which takes far longer
 * than the other lookups on a large repository.
 */
const GIT_HISTORY_TIMEOUT_MS = 60_000;
const DETAIL_MAX = 200;

export interface RepoIdentity {
  /** Root commit the identity is derived from. Never published. */
  rootSha: string;
  /** Public scope id — the `r` tag on bounty and claim events. */
  repoId: string;
  /** 32-byte NIP-44 v2 conversation key for bounty content. */
  repoKey: Uint8Array;
}

export type RepoIdentityFailure =
  | 'no-workspace'
  | 'not-git'
  | 'no-commits'
  | 'shallow'
  | 'git-error';

export type RepoIdentityResult =
  | ({ ok: true } & RepoIdentity)
  | { ok: false; reason: RepoIdentityFailure; detail?: string };

/** Derive the public id and the content key from a root commit sha. */
export function deriveRepoIdentity(rootSha: string): RepoIdentity {
  const normalized = rootSha.trim().toLowerCase();
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(normalized)) {
    throw new Error('Root commit must be a 40- or 64-character hex object id');
  }
  const derive = (label: string) =>
    new Uint8Array(hkdfSync('sha256', normalized, HKDF_SALT, label, 32));
  return {
    rootSha: normalized,
    repoId: Buffer.from(derive('repo-id')).toString('hex'),
    repoKey: derive('repo-key'),
  };
}

/**
 * Pick the identifying root out of `git rev-list --max-parents=0 HEAD` output.
 * A history can have several roots (unrelated histories merged together); the
 * lexicographically smallest is chosen so every clone picks the same one.
 */
export function pickRootCommit(revListOutput: string): string | undefined {
  const roots = revListOutput
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter((line) => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(line))
    .sort();
  return roots[0];
}

/**
 * Run git and resolve with trimmed stdout. Rejects with git's own stderr as the
 * message (or a timeout note), so a failure can be reported as it really is.
 */
function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf-8', timeout },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout.trim());
          return;
        }
        const killed = (error as { killed?: boolean }).killed;
        const message = killed
          ? 'git took too long to read the repository history'
          : (stderr ?? '').toString().trim() || error.message;
        reject(new Error(message));
      }
    );
  });
}

function detailOf(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text;
}

let lookup: Promise<RepoIdentityResult> | undefined;

/**
 * The workspace's repository identity.
 *
 * Concurrent callers share one in-flight lookup, and a success is cached for
 * the session. A failure is NOT cached: the repository may get its first
 * commit, or a transient git error may clear, and the next call must see that
 * without a window reload.
 */
export function getRepoIdentity(): Promise<RepoIdentityResult> {
  if (!lookup) {
    const pending = readRepoIdentity();
    lookup = pending;
    void pending.then((result) => {
      if (!result.ok && lookup === pending) {
        lookup = undefined;
      }
    });
  }
  return lookup;
}

/** Forget the cached identity. Test-only. */
export function _resetRepoIdentityForTests(): void {
  lookup = undefined;
}

async function readRepoIdentity(): Promise<RepoIdentityResult> {
  const root = workspaceRoot();
  if (!root) {
    return { ok: false, reason: 'no-workspace' };
  }
  try {
    await git(root, ['rev-parse', '--git-dir']);
  } catch {
    return { ok: false, reason: 'not-git' };
  }
  // An unborn HEAD is the only real "no commits" case. Checking it directly
  // keeps any other git failure from being misreported as one.
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  } catch {
    return { ok: false, reason: 'no-commits' };
  }
  // A shallow clone reports its shallow boundary as the root, which would put
  // this clone in a different scope from everyone else — refuse rather than
  // silently showing (and creating) bounties nobody else can see.
  try {
    if ((await git(root, ['rev-parse', '--is-shallow-repository'])) === 'true') {
      return { ok: false, reason: 'shallow' };
    }
  } catch {
    /* very old git without the flag — treat as a full clone */
  }
  let rootSha: string | undefined;
  try {
    rootSha = pickRootCommit(
      await git(root, ['rev-list', '--max-parents=0', 'HEAD'], GIT_HISTORY_TIMEOUT_MS)
    );
  } catch (err) {
    return { ok: false, reason: 'git-error', detail: detailOf(err) };
  }
  if (!rootSha) {
    return { ok: false, reason: 'git-error', detail: 'git returned no root commit' };
  }
  return { ok: true, ...deriveRepoIdentity(rootSha) };
}

/** User-facing explanation for a failed identity lookup. */
export function describeRepoIdentityFailure(
  reason: RepoIdentityFailure,
  detail?: string
): string {
  switch (reason) {
    case 'no-workspace':
      return 'Open a folder that is a git repository to see and create bounties.';
    case 'not-git':
      return 'Sattest needs a git repository — bounties are scoped to the repository they belong to.';
    case 'no-commits':
      return 'This repository has no commits yet. Sattest identifies a repository by its first commit, so commit something first.';
    case 'shallow':
      return 'This is a shallow clone, so Sattest can\'t find the repository\'s first commit. Run "git fetch --unshallow" to see and create bounties.';
    case 'git-error':
      return (
        `Sattest couldn't read this repository's history with git${detail ? `: ${detail}` : ''}. ` +
        'Try again, or run "git rev-list --max-parents=0 HEAD" in a terminal to see the problem.'
      );
  }
}
