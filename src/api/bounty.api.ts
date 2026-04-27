import * as vscode from 'vscode';
import { BountyInfo, ClaimInfo } from '../bounty/bounty.types.js';
import { normalizedTestId, workspaceRoot } from '../test/test-item.util.js';
import { getNostrAuthHeaders } from './nostr-auth.js';
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

export async function fetchBounties(options: FetchBountiesOptions = {}): Promise<BountyInfo[]> {
  const { testId, includeInactive = false, repo, testIds } = options;
  try {
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
      throw new Error(`[fetchBounties] Failed to fetch bounties: ${response.status}`);
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
  fundingMode: 'custodial' | 'nwc' = 'custodial'
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

    const response = await fetch(`${getBackendUrl()}/bounties`, {
      method: 'POST',
      headers: await getNostrAuthHeaders({ 'Content-Type': 'application/json' }),
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
    });
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || `Backend error: ${response.status}`);
    }

    const newBounty = await response.json();
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
    const response = await fetch(
      `${getBackendUrl()}/bounties/${encodeURIComponent(paymentHash)}/check-paid`,
      {
        method: 'GET',
        headers: await getNostrAuthHeaders({ 'Content-Type': 'application/json' }),
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
    const response = await fetch(
      `${getBackendUrl()}/bounties/${encodeURIComponent(id)}/update-paid`,
      {
        method: 'PATCH',
        headers: await getNostrAuthHeaders({ 'Content-Type': 'application/json' }),
      }
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
    const claimResponse = await fetch(
      `${getBackendUrl()}/bounties/${encodeURIComponent(id)}/claim`,
      {
        method: 'POST',
        headers: await getNostrAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          lnurl: lnurl.trim(),
        }),
      }
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
      headers: await getNostrAuthHeaders({ 'Content-Type': 'application/json' }),
    };
    if (refundLnurl) {
      init.body = JSON.stringify({ refundLnurl });
    }

    const response = await fetch(
      `${getBackendUrl()}/bounties/${encodeURIComponent(bountyId)}/deactivate`,
      init
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
    const response = await fetch(
      `${getBackendUrl()}/bounties/${encodeURIComponent(id)}/update-creator`,
      {
        method: 'PATCH',
        headers: await getNostrAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          creatorId: creatorPubkey.trim(),
        }),
      }
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
 * Approves a pending claim on a bounty by calling the backend approve endpoint.
 * @param bountyId - The bounty UUID (if separate from testId; otherwise use testId)
 * @returns The updated bounty data if successful, null on failure
 */
export async function approveClaim(
  bountyId: string,
  approvedBy: string
): Promise<BountyInfo | null> {
  try {
    const response = await fetch(
      `${getBackendUrl()}/bounties/${encodeURIComponent(bountyId)}/approve`,
      {
        method: 'POST',
        headers: await getNostrAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          approvedBy: approvedBy.trim(),
        }),
      }
    );

    if (!response.ok) {
      let errorMessage = `Approval failed: ${response.status}`;
      try {
        const errorData = await response.json();
        errorMessage = errorData.message || errorMessage;
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
