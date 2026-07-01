import * as vscode from 'vscode';
import { BountyInfo, ClaimInfo } from '../bounty/bounty.types.js';
import { normalizedTestId, workspaceRoot } from '../test/test-item.util.js';
import { authedFetch } from './authed-fetch.js';
import { getBackendUrl } from './config.js';
import { createLnbitsInvoice } from './lnbits.api.js';

export interface FetchBountiesOptions {
  testId?: string;
  includeInactive?: boolean;
  repo?: string;
  testIds?: string[];
}

// Extension activation fires multiple fetchBounties() calls in quick
// succession (initial load + post-Test-Controller refresh). If the backend
// is unreachable we don't want to spam the user with one toast per call —
// track the last time we surfaced an error so we only toast once per window.
let lastFetchErrorToastAt = 0;
const FETCH_ERROR_TOAST_COOLDOWN_MS = 10_000;

// Backend's `/bounties/filter` rejects requests with more than this many test
// IDs as a DoS guard. We respect it by chunking large workspaces into
// successive requests and merging the results client-side.
const FILTER_CHUNK_SIZE = 500;

export async function fetchBounties(options: FetchBountiesOptions = {}): Promise<BountyInfo[]> {
  const { testId, includeInactive = false, repo, testIds } = options;
  try {
    // Large workspaces can blow past the per-request testIds cap. Split into
    // chunks, fire them in parallel, and merge — de-duplicating by bounty id
    // in case the backend ever returns the same bounty under multiple chunks
    // (defense in depth; current schema makes that impossible).
    if (testIds && testIds.length > FILTER_CHUNK_SIZE) {
      const chunks: string[][] = [];
      for (let i = 0; i < testIds.length; i += FILTER_CHUNK_SIZE) {
        chunks.push(testIds.slice(i, i + FILTER_CHUNK_SIZE));
      }
      const results = await Promise.all(
        chunks.map((chunk) =>
          fetchBounties({ testId, includeInactive, repo, testIds: chunk })
        )
      );
      const merged = new Map<string, BountyInfo>();
      for (const list of results) {
        for (const b of list) {
          merged.set(b.id, b);
        }
      }
      return Array.from(merged.values());
    }

    const usePost = testIds && testIds.length > 0;
    const url = new URL(`${getBackendUrl()}/bounties${usePost ? '/filter' : ''}`);
    if (testId) {
      url.searchParams.append('testId', testId);
    }
    if (includeInactive) {
      url.searchParams.append('includeInactive', 'true');
    }
    if (repo) {
      url.searchParams.append('repo', repo);
    }

    const fetchOptions: RequestInit = usePost
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ testIds }),
        }
      : {};

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      // Pull the backend's JSON error body so callers (and us, in the dev
      // console) can see which validator rejected what — the bare status code
      // is useless when /bounties/filter has multiple Zod rules.
      let detail = '';
      try {
        const errBody = (await response.json()) as {
          error?: string;
          issues?: Array<{ field: string; message: string }>;
        };
        const issues = errBody.issues
          ?.map((i) => `${i.field}: ${i.message}`)
          .join('; ');
        detail = issues
          ? ` (${errBody.error ?? 'Validation failed'} — ${issues})`
          : errBody.error
            ? ` (${errBody.error})`
            : '';
      } catch {
        /* body wasn't JSON */
      }
      throw new Error(
        `[fetchBounties] Failed to fetch bounties: ${response.status}${detail} (url=${url.toString()}, method=${usePost ? 'POST' : 'GET'})`
      );
    }

    const data = await response.json();
    const backendBounties = data.bounties || [];
    const rootPath = workspaceRoot();

    backendBounties.forEach((b: BountyInfo) => {
      if (b.testId.startsWith('/')) {
        b.testId = rootPath + b.testId;
      } else {
        b.testId = rootPath + '/' + b.testId;
      }
      // Normalize: backend may omit `claims` for bounties with none. Downstream
      // code (claim/approve handlers, code-lens) treats it as an array, so
      // guarantee that contract here rather than scattering `?? []` checks.
      if (!Array.isArray(b.claims)) {
        b.claims = [];
      }
    });
    return backendBounties;
  } catch (error) {
    console.error('[fetchBounties] Error fetching bounties:', error);
    const now = Date.now();
    if (now - lastFetchErrorToastAt > FETCH_ERROR_TOAST_COOLDOWN_MS) {
      lastFetchErrorToastAt = now;
      vscode.window.showErrorMessage('Failed to load bounties from backend');
    }
    return [];
  }
}

// Fetch all bounties from backend (or filter by testId)
export async function createBounty(
  amountSats: number,
  lnbitsUrl: string | undefined,
  lnbitsApiKey: string | undefined,
  test: vscode.TestItem,
  creatorId: string | undefined,
  repo?: string,
  fundingMode: 'custodial' | 'nwc' = 'nwc'
): Promise<BountyInfo | undefined> {
  try {
    let invoiceForApi = '';
    let paymentHashForApi = '';
    const memo = `Bounty for test "${test.label}"`;
    // NWC bounties are funded from the creator's own wallet on approval, so
    // there's no up-front LNbits invoice to mint.
    if (fundingMode === 'custodial' && !lnbitsUrl && lnbitsApiKey) {
      const { payment_request: invoice, payment_hash } = await createLnbitsInvoice(
        lnbitsUrl as string,
        lnbitsApiKey as string,
        amountSats,
        memo
      );
      invoiceForApi = invoice;
      paymentHashForApi = payment_hash;
    }

    const response = await authedFetch(`${getBackendUrl()}/bounties`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        testId: normalizedTestId(test),
        frontEndInvoice: invoiceForApi,
        frontEndPaymentHash: paymentHashForApi,
        amountSats: amountSats,
        creatorId: creatorId,
        memo,
        // Tagging the bounty with the workspace's git repo slug lets the
        // backend serve per-repo listings to unauthenticated clients. Omitted
        // when the workspace has no configured git remote.
        ...(repo ? { repo } : {}),
        // Only forward a non-default fundingMode — keeps the wire format
        // backward-compatible with older backends that don't know the field.
        ...(fundingMode !== 'custodial' ? { fundingMode } : {}),
      }),
    }, { interactiveReauth: true, scope: 'write' });
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || `Backend error: ${response.status}`);
    }

    const newBounty = await response.json();
    // Same normalization as fetchBounties — a fresh bounty has no claims and
    // the backend omits the field. Guarantee an empty array so callers can
    // safely index `.claims[0]`.
    if (newBounty && !Array.isArray(newBounty.claims)) {
      newBounty.claims = [];
    }
    return newBounty;
  } catch (error) {
    console.error('[fetchBounties] Error creating bounty:', error);
    vscode.window.showErrorMessage('Failed to create bounty in backend');
    return;
  }
}

/**
 * Checks with Lnbits to see if the invoice has been paid
 * @param paymentHash - the invoice hash of the bounty payment
 * @returns true if invoice has been paid, false otherwise
 */
export async function checkPaidStatus(paymentHash: string): Promise<boolean | undefined> {
  try {
    const response = await authedFetch(
      `${getBackendUrl()}/bounties/${encodeURIComponent(paymentHash)}/check-paid`,
      {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Backend update failed: ${response.status} - ${errorText}`);
    }

    const checkPaidResponse = await response.json();
    return checkPaidResponse.paid;
  } catch (error) {
    console.error('[checkPaid] Error checkings paid status:', error);
    return false;
  }
}

/**
 * Updates the invoicePaid status for a specific bounty on the backend.
 * @param id - bounty unique ID
 * @returns true if update succeeded, false otherwise
 */
export async function updatePaidStatus(id: string): Promise<boolean> {
  try {
    const response = await authedFetch(
      `${getBackendUrl()}/bounties/${encodeURIComponent(id)}/update-paid`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
      },
      { interactiveReauth: true, scope: 'write' }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Backend update failed: ${response.status} - ${errorText}`);
    }

    return true;
  } catch (error) {
    console.error('[updatePaidStatus] Error updating paid status:', error);
    vscode.window.showErrorMessage(
      `Failed to sync payment status: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    return false;
  }
}

/**
 * Submits a claim request to the backend for a bounty using the claimer's LNURL.
 * @param id - The bounty ID (UUID from the bounties table)
 * @param lnurl - The claimer's LNURL (withdrawal link)
 * @returns The updated bounty info if successful, null on failure
 */
export async function claimBountyWithLnAddress(
  id: string,
  lnurl: string
): Promise<ClaimInfo | null> {
  try {
    const claimResponse = await authedFetch(
      `${getBackendUrl()}/bounties/${encodeURIComponent(id)}/claim`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lnurl: lnurl.trim(),
        }),
      },
      { interactiveReauth: true, scope: 'write' }
    );

    if (!claimResponse.ok) {
      const errorText = await claimResponse.text().catch(() => 'Unknown error');
      throw new Error(`Claim failed: ${claimResponse.status} - ${errorText}`);
    }

    const updatedClaim = await claimResponse.json();

    return updatedClaim;
  } catch (error) {
    console.error('[claimBounty] Error claiming bounty:', error);
    vscode.window.showErrorMessage(
      `Failed to claim bounty: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    return null;
  }
}

/**
 * Resolves an LNURL/LN-address and returns its sendable bounds (millisats) so
 * the claim input box can pre-check that the bounty amount fits the destination
 * wallet. Reuses the backend's `checkValidLnurl` resolver via POST /lnurl/limits.
 *
 * Fails open: returns `null` on any non-OK response or network error. Callers
 * must treat `null` as "couldn't determine" and not block — the backend claim
 * endpoint remains the authoritative range check.
 */
export async function getLnurlLimits(
  lnurl: string
): Promise<{ minSendable: number; maxSendable: number } | null> {
  try {
    const response = await authedFetch(`${getBackendUrl()}/lnurl/limits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lnurl: lnurl.trim() }),
    });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as { minSendable: number; maxSendable: number };
    if (typeof data?.minSendable !== 'number' || typeof data?.maxSendable !== 'number') {
      return null;
    }
    return { minSendable: data.minSendable, maxSendable: data.maxSendable };
  } catch (error) {
    console.error('[getLnurlLimits] Error:', error);
    return null;
  }
}

export interface DeactivateBountyResult {
  success: boolean;
  refund?: { checkingId: string; amountSats: number };
}

/**
 * Deactivates a bounty. If `refundLnurl` is supplied, the backend  will 
 * also fire a refund payout to that LNURL/LN-address before deactivating.
 * @param bountyId - The bounty UUID
 * @param refundLnurl - Optional LNURL/LN-address to refund the funded amount to
 * @returns { success, refund? } — `refund` populated only when a payout fired
 */
export async function deactivateBounty(
  bountyId: string,
  refundLnurl?: string
): Promise<DeactivateBountyResult> {
  try {
    const init: RequestInit = {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
    };
    if (refundLnurl) {
      init.body = JSON.stringify({ refundLnurl });
    }

    const response = await authedFetch(
      `${getBackendUrl()}/bounties/${encodeURIComponent(bountyId)}/deactivate`,
      init,
      { interactiveReauth: true, scope: 'write' }
    );

    if (!response.ok) {
      let errorMessage = `Deactivation failed: ${response.status}`;
      try {
        const errorData = await response.json();
        // Prefer the dev-mode `message` (real exception text) over the
        // generic `error` ("Failed to deactivate bounty") so the user
        // actually sees what went wrong instead of a tautology.
        const detail =
          errorData.message && errorData.message !== 'Internal server error'
            ? `${errorData.error}: ${errorData.message}`
            : errorData.error || errorData.message;
        errorMessage = detail || errorMessage;
      } catch {
        /* body wasn't JSON */
      }
      throw new Error(errorMessage);
    }

    const data = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      refund?: { checkingId: string; amountSats: number };
    };

    return {
      success: data.success ?? true,
      refund: data.refund,
    };
  } catch (error) {
    console.error('[deactivateBounty] Error:', error);
    vscode.window.showErrorMessage(
      `Failed to deactivate bounty: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    return { success: false };
  }
}

/**
 * Sets the creator_id (Nostr pubkey) on an existing bounty.
 * @param id - The bounty ID (UUID)
 * @param creatorPubkey - The creator's Nostr pubkey (npub...)
 * @returns Updated bounty or null on failure
 */
export async function setBountyCreator(
  id: string,
  creatorPubkey: string
): Promise<BountyInfo | null> {
  try {
    const response = await authedFetch(
      `${getBackendUrl()}/bounties/${encodeURIComponent(id)}/update-creator`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          creatorId: creatorPubkey.trim(),
        }),
      },
      { interactiveReauth: true, scope: 'write' }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Set creator failed: ${response.status} - ${errorText}`);
    }

    const updatedBounty = await response.json();

    return updatedBounty;
  } catch (error) {
    console.error('[setBountyCreator] Error:', error);
    vscode.window.showErrorMessage(
      `Failed to set creator: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    return null;
  }
}

/**
 * Retrieves the current pending claim on a bounty so the creator can review
 * the payout destination (claimantLnurl) before confirming approval. Only the
 * bounty creator can call this endpoint; returns null when there is no pending
 * claim or the request fails.
 */
export async function getPendingClaim(
  bountyId: string
): Promise<{ id: string; claimantLnurl: string; claimedAt: string; status: string } | null> {
  try {
    const response = await authedFetch(
      `${getBackendUrl()}/bounties/${encodeURIComponent(bountyId)}/pending-claim`,
      { method: 'GET' }
    );
    if (!response.ok) return null;
    const data = await response.json();
    if (!data?.id || !data?.claimantLnurl) return null;
    return data as { id: string; claimantLnurl: string; claimedAt: string; status: string };
  } catch {
    return null;
  }
}

/**
 * Approves a pending claim on a bounty by calling the backend approve endpoint.
 * `claimId` must be the UUID of the specific claim the creator reviewed — the
 * backend rejects any mismatch to prevent claim front-running (an attacker
 * submitting a later claim to redirect the payout to their own LNURL).
 * @param bountyId  - The bounty UUID
 * @param claimId   - The specific claim UUID to approve (from getPendingClaim)
 * @returns The updated bounty data if successful, null on failure
 */
export async function approveClaim(
  bountyId: string,
  claimId: string
): Promise<BountyInfo | null> {
  try {
    const response = await authedFetch(
      `${getBackendUrl()}/bounties/${encodeURIComponent(bountyId)}/approve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimId }),
      },
      { interactiveReauth: true, scope: 'write' }
    );

    if (!response.ok) {
      let errorMessage = `Approval failed: ${response.status}`;
      try {
        const errorData = await response.json();
        // The NWC payout failure (502) returns the real reason in `error`
        // (e.g. "reply timeout", "wallet offline", "insufficient budget").
        // The generic 500 puts dev-mode detail in `message`. Prefer whichever
        // is actually informative so the user sees *why* it failed, not just
        // "Approval failed: 502".
        const detail =
          errorData.message && errorData.message !== 'Internal server error'
            ? errorData.message
            : errorData.error;
        errorMessage = detail || errorMessage;
      } catch {
        // Ignore JSON parse error if response is not JSON
      }
      throw new Error(errorMessage);
    }

    const updatedBounty = await response.json();
    return updatedBounty;
  } catch (error) {
    console.error('[approveClaim] Error approving claim:', error);
    vscode.window.showErrorMessage(
      `Failed to approve claim: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    return null;
  }
}
