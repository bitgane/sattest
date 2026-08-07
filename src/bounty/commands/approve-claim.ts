import * as vscode from 'vscode';
import {
  BountyInfo,
  claimStatusApproved,
  claimStatusApproving,
} from '../bounty.types.js';
import { removeParentLabelFromTestId } from '../../test/test-item.util.js';
import { getNostrUserPubkey } from '../../state.js';
import { getNwcStatus } from '../../api/nwc.api.js';
import { approveClaim, getPendingClaims, type PendingClaim } from '../../api/bounty.api.js';
import {
  evidenceIcon,
  evidenceLabel,
  describeTopCommit,
  showClaimDiff,
  evidenceDetailLine,
} from '../claim-evidence.js';
import {
  verifyClaimTrailer,
  fetchAllRemotes,
  hasRemotes,
  type ClaimEvidence,
  type ClaimEvidenceResult,
} from '../../git/claim-trailer.js';

export const approveClaimCommand = (
  bounties: Map<string, BountyInfo>,
  onBountiesChangedEmitter: vscode.EventEmitter<void>
) => {
  // Approvals in flight, keyed by bounty id. The signer round-trip + NWC payout
  // can take many seconds, during which the "✅ Approve Claim" lens stays
  // clickable — a second click used to fire a second /approve that landed after
  // the first, surfacing a contradictory "Claim is not pending" failure toast
  // next to the success. Guarding here stops the duplicate request at the source.
  const inFlight = new Set<string>();

  return vscode.commands.registerCommand('sattest.approveClaim', async (test?: vscode.TestItem) => {
    if (!test || !test.id) {
      vscode.window.showErrorMessage('No test selected');
      return;
    }

    let bounty = bounties.get(test.id.trim()) as BountyInfo;
    if (!bounty && test.parent) {
      const testId = removeParentLabelFromTestId(test);
      bounty = bounties.get(testId) as BountyInfo;
    }
    if (!bounty) {
      vscode.window.showErrorMessage('Bounty not found');
      return;
    }
    const userNostrPubkey = await getNostrUserPubkey();
    if (bounty.creatorId !== userNostrPubkey) {
      vscode.window.showErrorMessage('Not authorized to approve this claim');
      return;
    }

    // Ignore a second click while an approval for this bounty is already
    // running (the payout can take a while — see `inFlight` above).
    if (inFlight.has(bounty.id)) {
      vscode.window.showInformationMessage('This claim is already being approved…');
      return;
    }

    // Fetch the open claims from the backend before showing the confirmation
    // dialog. This serves three purposes:
    //   1. Transparency — the creator sees who is being paid, and (unless the
    //      claimant hid it) which LNURL receives the funds.
    //   2. Choice — claims are open to anyone, so a bounty can have several.
    //      The creator identifies their contributor out-of-band, so only they
    //      can say which claim is the right one. Picking "the newest" for them
    //      is what let an attacker file a late claim and be paid instead.
    //   3. Claim binding — we pass both `claimId` and `claimantPubkey` to the
    //      approve endpoint, so a claim substituted in the interim is rejected
    //      rather than silently paid.
    const pendingClaims = await getPendingClaims(bounty.id);
    if (pendingClaims.length === 0) {
      vscode.window.showErrorMessage(
        'Could not retrieve claim details — the claim may have already been approved or removed.'
      );
      return;
    }

    // Look up each claimant's trailer commits in local git. This is evidence
    // for the creator to read, not a verdict: teams differ, and "in your
    // branch" is the same answer whether they merged a fork's PR or simply
    // share a feature branch with the claimant.
    const evidenceFor = (claim: PendingClaim): ClaimEvidenceResult =>
      claim.claimantPubkey
        ? verifyClaimTrailer(bounty.id, claim.claimantPubkey)
        : { evidence: 'unknown', commits: [] };

    let scored = pendingClaims.map((claim) => ({ claim, result: evidenceFor(claim) }));

    // Commits already in the creator's branch sort first — a helpful default
    // highlight, not a gate. Nothing below refuses to pay on this ordering.
    const rank: Record<ClaimEvidence, number> = {
      'in-history': 0,
      elsewhere: 1,
      absent: 2,
      unknown: 3,
    };
    const byEvidence = (
      a: { result: ClaimEvidenceResult },
      b: { result: ClaimEvidenceResult }
    ) => rank[a.result.evidence] - rank[b.result.evidence];
    scored.sort(byEvidence);

    // Nothing found anywhere, but there are remotes to ask — the commits may
    // simply not have arrived on this machine yet, which is the normal state
    // when reviewing a PR you haven't fetched. Offer to go get them rather
    // than telling the creator their workflow is wrong.
    if (scored.every((s) => s.result.evidence === 'absent') && hasRemotes()) {
      const choice = await vscode.window.showInformationMessage(
        'No commit in this repo carries this claimant\'s key yet. Fetch from your remotes and re-check?',
        'Fetch and re-check',
        'Continue anyway'
      );
      if (choice === 'Fetch and re-check') {
        const fetched = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Sattest: fetching…' },
          async () => fetchAllRemotes()
        );
        if (fetched) {
          scored = pendingClaims.map((claim) => ({ claim, result: evidenceFor(claim) }));
          scored.sort(byEvidence);
        }
      } else if (choice !== 'Continue anyway') {
        return; // dismissed → approve nothing
      }
    }

    let chosen = scored[0];
    if (scored.length > 1) {
      // More than one person has claimed this bounty. Never guess — make the
      // creator name the recipient. The pubkey is the stable identifier here;
      // the LNURL may be hidden, and is attacker-chosen either way.
      const picked = await vscode.window.showQuickPick(
        scored.map((s) => ({
          label: s.claim.claimantPubkey
            ? `${evidenceIcon(s.result.evidence)} ${s.claim.claimantPubkey.slice(0, 16)}…${s.claim.claimantPubkey.slice(-8)}`
            : '$(question) Unknown claimant (legacy claim)',
          description: [
            evidenceLabel(s.result),
            s.claim.status === claimStatusApproving ? 'payout processing' : '',
          ]
            .filter(Boolean)
            .join(' · '),
          detail: [
            describeTopCommit(s.result),
            // Say so explicitly when the address is hidden — silence would read
            // as "no address", and the creator should know the difference.
            s.claim.lnurlHidden
              ? 'address hidden by the claimant'
              : `pays ${s.claim.claimantLnurl ?? 'unknown'}`,
          ]
            .filter(Boolean)
            .join(' · '),
          // `claim` is the selection; `entry` carries the evidence alongside it
          // so the confirm dialog can show the commit without re-running git.
          claim: s.claim,
          entry: s,
        })),
        {
          title: `${scored.length} people have claimed this bounty — who are you paying?`,
          placeHolder: 'Match the commit against the work you reviewed',
          ignoreFocusOut: true,
        }
      );
      if (!picked) {
        return; // dismissed → approve nothing
      }
      chosen = picked.entry;
    }
    const pendingClaim = chosen.claim;

    // Build the destination line for the confirmation dialog. When the claimant
    // opted into privacy, the backend redacts the address (`claimantLnurl` is
    // null, `lnurlHidden` true) — the creator approves without seeing it. The
    // payout is still bound to this exact claim via `claimId` and routed to the
    // pinned address server-side, so hiding it doesn't weaken front-running
    // protection; the creator just can't eyeball the destination.
    let destinationLine: string;
    if (pendingClaim.lnurlHidden || !pendingClaim.claimantLnurl) {
      destinationLine = 'the claimant';
    } else {
      // Truncate a long LNURL so the creator can verify it without the full
      // string overwhelming the dialog. The claimId binding is the real check.
      const lnurl = pendingClaim.claimantLnurl;
      destinationLine =
        lnurl.length > 50 ? `${lnurl.slice(0, 24)}…${lnurl.slice(-16)}` : lnurl;
    }

    // A claim already in `approving` is one whose payout outcome was never
    // confirmed — the sats may or may not have left. Approving it again does
    // NOT pay blind: the backend asks the wallet what happened first, and only
    // pays if the wallet confirms the earlier attempt failed. Say that, rather
    // than showing a "Send N sats" modal that misrepresents what the click does.
    const isRecheck = pendingClaim.status === claimStatusApproving;

    let confirmed: string | undefined;
    if (isRecheck) {
      confirmed = await vscode.window.showWarningMessage(
        `Re-check this ${bounty.amountSats} sat payout with your wallet?`,
        {
          modal: true,
          detail:
            'Sattest couldn\'t confirm the last attempt. It will ask your wallet ' +
            'whether the payment went through, and only send again if your wallet ' +
            'confirms it did not.',
        },
        'Re-check Payout'
      );
    } else {
      // Loop so "Review changes" opens the patch and returns to the same
      // decision, rather than dropping the creator out of the flow. Reviewing
      // the code is the whole point of the trailer binding — the dialog is
      // where that decision is made, so the diff belongs one click away from it.
      const canReview = chosen.result.commits.length > 0;
      for (;;) {
        // Modal dialogs render VS Code's own Cancel button — passing an
        // explicit 'Cancel' item here used to show two of them. Dismissal
        // resolves to undefined, which the guard below treats as "don't approve".
        const actions = canReview
          ? ['Yes, Approve Payout', 'Review changes']
          : ['Yes, Approve Payout'];
        confirmed = await vscode.window.showWarningMessage(
          `Send ${bounty.amountSats} sats to:\n${destinationLine}`,
          {
            modal: true,
            // The claimant pubkey is always shown, even when the payout address
            // is hidden. Hiding an *address* is a supported privacy choice;
            // hiding *who is being paid* from the payer left the creator with
            // nothing to check, which is what made a substituted claim
            // invisible at exactly the moment it mattered.
            //
            // The commit line goes here rather than behind a warning modal:
            // this is the moment the creator decides, and a commit subject they
            // recognise is worth more than any grade we could compute.
            detail:
              `Bounty: "${test?.label}"\n` +
              `Claimant: ${pendingClaim.claimantPubkey ?? 'unknown (legacy claim)'}\n` +
              evidenceDetailLine(chosen.result),
          },
          ...actions
        );
        if (confirmed !== 'Review changes') {
          break;
        }
        await showClaimDiff(chosen.result, pendingClaim.claimantPubkey);
      }
    }

    if (confirmed !== (isRecheck ? 'Re-check Payout' : 'Yes, Approve Payout')) {
      return;
    }

    // NWC bounties pay out from the creator's own connected Lightning wallet,
    // which the backend reads server-side at approval time. If the extension
    // can't detect a connected wallet — the URI was never saved/was cleared, or
    // the Nostr session needed to read it has lapsed — the /approve call fails
    // before doing anything useful (and, when the session is gone, never even
    // reaches the backend). Prompt the creator to (re)connect their wallet so
    // they can paste their NWC URI and complete the payout.
    if (bounty.fundingMode !== 'custodial') {
      let nwc = await getNwcStatus();
      if (!nwc.configured) {
        const choice = await vscode.window.showWarningMessage(
          'Your Lightning wallet (NWC) isn\'t connected, so this payout can\'t be sent. Connect it to complete the approval.',
          'Connect Wallet',
          'Cancel'
        );
        if (choice !== 'Connect Wallet') {
          return;
        }
        await vscode.commands.executeCommand('sattest.connectWallet');
        nwc = await getNwcStatus();
        if (!nwc.configured) {
          vscode.window.showWarningMessage(
            'Lightning wallet still not connected — claim not approved.'
          );
          return;
        }
      }
    }

    inFlight.add(bounty.id);
    try {
      const result = await approveClaim(
        bounty.id,
        pendingClaim.id,
        pendingClaim.claimantPubkey
      );
      if (result === 'claimant-changed') {
        // The backend refused because the open-claim set changed under us (a
        // new claim landed, or this one isn't the claimant we named). The user
        // has already seen the reason; re-open the picker rather than paying.
        onBountiesChangedEmitter.fire();
        return;
      }
      if (!result) {
        // approveClaim() handles its own error toast (e.g. the backend's 502
        // with the real NWC failure reason) and returns null. Bail here so we
        // don't also show a contradictory "payout triggered" success toast.
        return;
      }

      if (result === 'in-progress') {
        // Another approve (e.g. a second VS Code window) is handling this claim
        // right now. Not our success to claim, not a failure either.
        vscode.window.showInformationMessage('This claim is already being approved…');
        return;
      }

      if (result === 'outcome-unknown') {
        // The payout request reached the wallet but no confirmation came back.
        // It may well have been paid, so this is explicitly NOT reported as a
        // failure — telling the creator it failed would push them to resend and
        // pay the claimant twice. The backend holds the claim and reconciles it
        // against the wallet on the next approve.
        vscode.window.showWarningMessage(
          'Couldn\'t confirm this payout — your wallet may have already sent it. ' +
            'The claim is on hold so it can\'t be paid twice. Don\'t resend from ' +
            'your wallet; click the "Payout Processing" lens in a minute to re-check.'
        );
        // Reflect the on-hold state so the lens stops offering Approve.
        if (bounty.claims?.[0]) {
          bounty.claims[0].status = claimStatusApproving;
        }
        bounties.set(test.id, bounty);
        onBountiesChangedEmitter.fire();
        return;
      }

      // Fresh success, or the backend told us it was already approved (a
      // duplicate that raced us). Either way the claim is approved and paid —
      // reflect that locally and show the success toast, never a failure.
      if (bounty.claims?.[0]) {
        bounty.claims[0].status = claimStatusApproved;
      }
      bounties.set(test.id, bounty);
      onBountiesChangedEmitter.fire();

      vscode.window.showInformationMessage(
        result === 'already-approved'
          ? 'This claim was already approved — payout completed.'
          : 'Claim approved – payout triggered!'
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Approval error: ${err}`);
    } finally {
      inFlight.delete(bounty.id);
    }
  });
};
