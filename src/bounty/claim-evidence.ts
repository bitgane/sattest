import * as vscode from 'vscode';
import {
  readCommitPatches,
  type ClaimEvidence,
  type ClaimEvidenceResult,
} from '../git/claim-trailer.js';

/**
 * Rendering helpers for the "approve claim" dialog: they turn a
 * {@link ClaimEvidenceResult} (where a claimant's commits actually live) into
 * the icons, one-line labels, and reviewable diff the creator sees before
 * releasing a payout. Extracted from bounty.util.ts so the approve command reads
 * as orchestration rather than string-formatting.
 */

export function evidenceIcon(e: ClaimEvidence): string {
  switch (e) {
    case 'in-history':
      return '$(git-commit)';
    case 'elsewhere':
      return '$(git-branch)';
    default:
      return '$(question)';
  }
}

/**
 * Where this claimant's commits live, in one line.
 *
 * Phrased as location rather than judgement: a team sharing a feature branch
 * never "merges" anything, and a maintainer reviewing a fetched PR hasn't
 * merged it *yet*. Both are ordinary, so neither gets scolded.
 */
export function evidenceLabel(result: ClaimEvidenceResult): string {
  switch (result.evidence) {
    case 'in-history':
      return result.currentBranch
        ? `in your current branch (${result.currentBranch})`
        : 'in your current branch';
    case 'elsewhere': {
      // Prefer the remote-tracking refs — "origin/pr-99" tells the creator far
      // more than a local branch name they may not recognise.
      const refs = result.commits.flatMap((c) => c.refs);
      const shown = Array.from(new Set(refs)).slice(0, 2);
      return shown.length > 0 ? `on ${shown.join(', ')}` : 'in this repo, not on your branch';
    }
    case 'absent':
      return 'no commit found in this repo';
    case 'unknown':
      return 'could not check this repo';
  }
}

/** The commit a creator would actually look at, rendered for a dialog line. */
export function describeTopCommit(result: ClaimEvidenceResult): string | undefined {
  const top = result.commits[0];
  if (!top) {
    return undefined;
  }
  return `"${top.subject}" (${top.sha.slice(0, 8)})`;
}

/**
 * Open the claimant's commits as a patch, so the creator can read what they're
 * paying for instead of trusting a commit subject.
 *
 * Rendered into an untitled `diff` document rather than through the built-in
 * git extension's diff provider: this needs no extra dependency, works for
 * commits on any ref (including ones not checked out), and shows all of the
 * claimant's commits in one scrollable view. Never throws — failing to open a
 * review must not derail an approval the creator can still make.
 */
export async function showClaimDiff(
  result: ClaimEvidenceResult,
  claimantPubkey: string | null
): Promise<void> {
  try {
    const patch = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Sattest: loading changes…' },
      async () => readCommitPatches(result.commits.map((c) => c.sha))
    );
    if (!patch.trim()) {
      vscode.window.showInformationMessage('No changes to show for this claim.');
      return;
    }
    const header =
      `# Sattest — changes claimed by ${claimantPubkey ?? 'unknown claimant'}\n` +
      `# ${result.commits.length} commit(s), ${evidenceLabel(result)}\n` +
      '# Review only — editing this buffer changes nothing.\n\n';
    const doc = await vscode.workspace.openTextDocument({
      content: header + patch,
      language: 'diff',
    });
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
  } catch (err) {
    console.error('[showClaimDiff] failed:', err);
    vscode.window.showWarningMessage(
      `Couldn't load the claimant's changes: ${err instanceof Error ? err.message : 'Unknown error'}`
    );
  }
}

/** The "Backed by:" line in the approve confirmation. */
export function evidenceDetailLine(result: ClaimEvidenceResult): string {
  const commit = describeTopCommit(result);
  const where = evidenceLabel(result);
  if (!commit) {
    return `Backed by: ${where}`;
  }
  const more = result.commits.length > 1 ? ` +${result.commits.length - 1} more` : '';
  return `Backed by: ${commit}${more} — ${where}`;
}
