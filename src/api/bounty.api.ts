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
    vscode.window.showErrorMessage('Failed to load bounties from backend');
    return [];
  }
}

// Fetch all bounties from backend (or filter by testId)
export async function createBounty(
  amountSats: number,
  lnbitsUrl: string | undefined,
  lnbitsApiKey: string | undefined,
  test: vscode.TestItem,
  creatorId: string | undefined
): Promise<BountyInfo | undefined> {
  try {
    let invoiceForApi = '';
    let paymentHashForApi = '';
    const memo = `Bounty for test "${test.label}"`;
    if (!lnbitsUrl && lnbitsApiKey) {
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

/**
 * Deactivates (soft-deletes) a bounty by setting active = false.
 * @param bountyId - The bounty UUID
 * @returns true if successful
 */
export async function deactivateBounty(bountyId: string): Promise<boolean> {
  try {
    const response = await fetch(
      `${getBackendUrl()}/bounties/${encodeURIComponent(bountyId)}/deactivate`,
      {
        method: 'PATCH',
        headers: await getNostrAuthHeaders({ 'Content-Type': 'application/json' }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Deactivation failed: ${response.status} - ${errorText}`);
    }

    return true;
  } catch (error) {
    console.error('[deactivateBounty] Error:', error);
    vscode.window.showErrorMessage(
      `Failed to deactivate bounty: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    return false;
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
