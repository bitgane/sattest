import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { workspaceRoot } from '../test/test-item.util.js';

/**
 * Git-trailer claim binding.
 *
 * A bounty claim on its own is just an assertion — anyone with a Nostr keypair
 * can file one, and the creator has no way to tell which claim belongs to the
 * contributor whose work they actually reviewed. Typing a PR URL or a commit
 * SHA into a box doesn't fix that: an attacker types the honest contributor's
 * URL just as easily.
 *
 * So the binding runs through the one thing the attacker can't influence — the
 * creator's own repository. The claimant puts their Nostr pubkey inside the
 * commit as a trailer:
 *
 *     Sattest-Claim: <64-hex nostr pubkey>
 *
 * and the creator's extension reports, entirely offline, which commits in this
 * repo carry that claim and where those commits live.
 *
 * WHY A DIGEST RATHER THAN THE RAW PUBKEY: a commit message is permanent and,
 * in a public repo, scrapeable — a plaintext pubkey would build a lasting
 * git-identity ↔ nostr-identity map, and a nostr pubkey exposes that person's
 * profile, notes and often a lightning address. Hashing it with the bounty id
 * keeps the value opaque to a scraper while staying *locally* computable: the
 * creator already knows the bounty id and gets `claimantPubkey` from
 * /pending-claim, so they derive the expected token themselves.
 *
 * The alternative — an opaque token the backend resolves — was rejected: it
 * would make the server the authority on which pubkey a commit belongs to, so
 * a compromised backend could answer "this commit is the attacker's" and
 * reintroduce the payout hijack this whole mechanism exists to prevent.
 * Salting per bounty also means one claimant's trailers don't correlate
 * across bounties.
 *
 * Residual: someone who already suspects a specific pubkey can confirm it by
 * recomputing the digest. That's far weaker than publishing it outright.
 *
 * WHAT THIS MODULE DOES NOT DO: grade the result. Teams work differently —
 * creator and claimant may share a feature branch with no PR at all, or the
 * creator may be a maintainer approving after merging a fork's PR, or approving
 * a PR they've fetched but not yet merged. All of those are legitimate, so this
 * reports *location*, not trust, and leaves the decision to the creator, who is
 * reading the code anyway. `in-history` is a useful default sort, not a verdict.
 *
 * The trailer, not the SHA, is the identifier: commit messages survive squash
 * merges, rebases and cherry-picks; SHAs don't. (A squash whose message is
 * hand-edited to drop the trailer does lose the link — see `absent`.)
 *
 * Every command runs via `execFileSync` with argument arrays — never a shell
 * string — so a pubkey can never be interpolated into a command line. Pubkeys
 * are additionally shape-checked before use.
 */

/** Trailer key written into the claimant's commit message. */
export const CLAIM_TRAILER_KEY = 'Sattest-Claim';

/** Nostr pubkeys are 64 lowercase hex chars. Anything else never reaches git. */
const PUBKEY_RE = /^[0-9a-f]{64}$/i;

/** Local commands are bounded so a pathological repo can't hang the extension host. */
const GIT_TIMEOUT_MS = 10_000;

/** Fetch talks to the network, so it gets a much longer budget. */
const GIT_FETCH_TIMEOUT_MS = 120_000;

/** Cap on commits we enrich with ref names — `--contains` is the expensive call. */
const MAX_DETAILED_COMMITS = 5;

/** A patch can be large; give `git show` room before it errors on buffer size. */
const PATCH_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * The opaque value written into the commit trailer.
 *
 * `sha256(bountyId:pubkey)`, truncated. Both inputs are known to the creator at
 * approval time, so this is verifiable with no network call and no trust in the
 * backend — while revealing nothing to someone reading the repo's history.
 *
 * 16 hex chars (64 bits) is ample: this isn't a secret to brute-force, it's a
 * lookup key that has to be collision-resistant among the handful of claims on
 * one bounty.
 */
export function claimTrailerToken(bountyId: string, pubkey: string): string {
    return createHash('sha256')
        .update(`${bountyId.trim().toLowerCase()}:${pubkey.trim().toLowerCase()}`)
        .digest('hex')
        .slice(0, 16);
}

/**
 * Where a claimant's trailer commits sit relative to the creator's work.
 *
 * These are facts about location, not levels of trust:
 *
 *   'in-history' — a trailer commit is reachable from HEAD. True whether the
 *                  creator merged a PR or simply shares a feature branch with
 *                  the claimant, which is why it's the same answer for both.
 *   'elsewhere'  — trailer commits exist in this repo but aren't in HEAD: a
 *                  fetched PR ref, another branch, an unmerged topic branch.
 *   'absent'     — no commit here carries that pubkey. Usually means the
 *                  creator hasn't fetched yet, the claimant hasn't pushed, or
 *                  a squash dropped the trailer.
 *   'unknown'    — git couldn't answer (not a repo, git missing, command
 *                  failed). Deliberately distinct from 'absent': "we couldn't
 *                  check" must never render as "we checked and found nothing".
 */
export type ClaimEvidence = 'in-history' | 'elsewhere' | 'absent' | 'unknown';

export interface ClaimCommit {
    sha: string;
    subject: string;
    /** Branches containing this commit, e.g. ['main', 'origin/pr-99']. May be empty. */
    refs: string[];
    /** True when this commit is reachable from HEAD. */
    inHistory: boolean;
}

export interface ClaimEvidenceResult {
    evidence: ClaimEvidence;
    /** Trailer commits, newest first. Empty for 'absent' / 'unknown'. */
    commits: ClaimCommit[];
    /** Short name of the creator's current branch, for display. */
    currentBranch?: string;
}

function git(args: string[], timeout = GIT_TIMEOUT_MS, maxBuffer?: number): string {
    const cwd = workspaceRoot();
    if (!cwd) {
        throw new Error('No workspace folder open');
    }
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf-8',
        timeout,
        ...(maxBuffer ? { maxBuffer } : {}),
        // Keep git's own stderr out of the extension host output on the
        // expected-failure paths (`--is-ancestor` exits non-zero by design).
        stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
}

/** True when `sha` is reachable from HEAD — merged, or simply on this branch. */
function isInHistory(sha: string): boolean {
    try {
        // Exits 0 when reachable, 1 when not. `execFileSync` throws on non-zero,
        // so a throw here is a legitimate "no", not an error.
        git(['merge-base', '--is-ancestor', sha, 'HEAD']);
        return true;
    } catch {
        return false;
    }
}

/** Branches (local and remote-tracking) that contain `sha`. */
function refsContaining(sha: string): string[] {
    try {
        const out = git(['branch', '-a', '--contains', sha, '--format=%(refname:short)']);
        return out ? out.split('\n').map((r) => r.trim()).filter(Boolean) : [];
    } catch {
        return [];
    }
}

function currentBranchName(): string | undefined {
    try {
        const name = git(['rev-parse', '--abbrev-ref', 'HEAD']);
        return name && name !== 'HEAD' ? name : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Find every commit in this repository whose message carries `pubkey` in a
 * Sattest-Claim trailer, and report where those commits live.
 *
 * Searches `--all` (every ref, including fetched remotes) rather than just
 * HEAD, so a claim is recognisable before the creator merges — or without any
 * merge ever happening, as on a shared feature branch.
 */
export function verifyClaimTrailer(bountyId: string, pubkey: string): ClaimEvidenceResult {
    if (!PUBKEY_RE.test(pubkey) || !bountyId?.trim()) {
        return { evidence: 'unknown', commits: [] };
    }
    const token = claimTrailerToken(bountyId, pubkey);

    let rows: string[];
    try {
        // `-F` — the pattern is matched literally, never as a regex. The token
        // is a hex digest, so this is belt-and-braces.
        const out = git([
            'log',
            '--all',
            '--format=%H%x1f%s',
            '-F',
            `--grep=${CLAIM_TRAILER_KEY}: ${token}`,
        ]);
        rows = out ? out.split('\n').filter(Boolean) : [];
    } catch {
        // Not a git repo, git unavailable, or the command failed. "Couldn't
        // check" is not "checked and found nothing".
        return { evidence: 'unknown', commits: [] };
    }

    const currentBranch = currentBranchName();

    if (rows.length === 0) {
        return { evidence: 'absent', commits: [], currentBranch };
    }

    const commits: ClaimCommit[] = rows.slice(0, MAX_DETAILED_COMMITS).map((row) => {
        const [sha, subject = ''] = row.split('\x1f');
        return {
            sha,
            subject,
            inHistory: isInHistory(sha),
            refs: refsContaining(sha),
        };
    });

    // Reachable from HEAD covers both "I merged their PR" and "we're on the
    // same branch" — the creator's workflow doesn't change the answer.
    const evidence: ClaimEvidence = commits.some((c) => c.inHistory) ? 'in-history' : 'elsewhere';

    // Surface the most relevant commit first: one that's actually in the
    // creator's history, if any.
    commits.sort((a, b) => Number(b.inHistory) - Number(a.inHistory));

    return { evidence, commits, currentBranch };
}

/**
 * Fetch every remote, so a claim whose commits simply haven't arrived yet can
 * be re-checked.
 *
 * This is the answer to 'absent' in a PR-based workflow: the contributor's
 * commits exist, they're just not on this machine. Offering to go get them
 * beats telling the creator their process is wrong.
 *
 * Returns true on success. Never throws — a failed fetch just means the
 * re-check finds the same thing it did before.
 */
export function fetchAllRemotes(): boolean {
    try {
        git(['fetch', '--all', '--quiet'], GIT_FETCH_TIMEOUT_MS);
        return true;
    } catch {
        return false;
    }
}

/** True when this workspace has at least one remote configured to fetch from. */
export function hasRemotes(): boolean {
    try {
        return git(['remote']).length > 0;
    } catch {
        return false;
    }
}

/**
 * Append the claim trailer to the working tree's HEAD commit.
 *
 * Amending is what makes this zero-typing: the claimant claims, then runs one
 * command instead of hand-copying a key into a commit message. It rewrites
 * HEAD, so callers must confirm with the user first and should not offer it
 * for already-pushed commits without saying so.
 *
 * Returns the new HEAD sha. Throws with git's message on failure so the caller
 * can surface something actionable (e.g. "no commits yet").
 */
export function addClaimTrailerToHead(bountyId: string, pubkey: string): string {
    if (!PUBKEY_RE.test(pubkey)) {
        throw new Error('Refusing to write a malformed pubkey into a commit trailer');
    }
    if (!bountyId?.trim()) {
        throw new Error('A bounty is required to derive the claim trailer');
    }
    git([
        'commit',
        '--amend',
        '--no-edit',
        '--trailer',
        `${CLAIM_TRAILER_KEY}: ${claimTrailerToken(bountyId, pubkey)}`,
    ]);
    return git(['rev-parse', 'HEAD']);
}

/** True when HEAD's commit message already carries this claim's trailer. */
export function headHasClaimTrailer(bountyId: string, pubkey: string): boolean {
    if (!PUBKEY_RE.test(pubkey) || !bountyId?.trim()) {
        return false;
    }
    try {
        return git(['log', '-1', '--format=%B']).includes(
            `${CLAIM_TRAILER_KEY}: ${claimTrailerToken(bountyId, pubkey)}`
        );
    } catch {
        return false;
    }
}

/**
 * Read the full patch for each commit, for the creator to review before paying.
 *
 * This is the review half of the binding: knowing a commit exists is weaker
 * than reading what it changed. Falls back to `--stat` when the patch is too
 * large to buffer, so an enormous change degrades to a file list rather than
 * showing nothing.
 */
export function readCommitPatches(shas: string[]): string {
    const parts: string[] = [];
    for (const sha of shas.slice(0, MAX_DETAILED_COMMITS)) {
        try {
            parts.push(git(['show', '--patch-with-stat', '--no-color', sha], GIT_TIMEOUT_MS, PATCH_MAX_BUFFER));
        } catch {
            try {
                parts.push(
                    `# Patch too large or unreadable — showing summary only\n\n` +
                    git(['show', '--stat', '--no-color', sha])
                );
            } catch {
                parts.push(`# Could not read commit ${sha}`);
            }
        }
    }
    return parts.join('\n\n');
}

/** True when the workspace has at least one commit to amend. */
export function hasCommits(): boolean {
    try {
        git(['rev-parse', 'HEAD']);
        return true;
    } catch {
        return false;
    }
}
