import * as vscode from 'vscode';

jest.mock('./nostr-auth', () => ({
  getNostrAuthHeaders: jest.fn().mockImplementation(async (extra?: Record<string, string>) => ({
    Authorization: 'Nostr dGVzdC1hdXRoLWV2ZW50',
    ...extra,
  })),
}));

jest.mock('./config', () => ({
  getBackendUrl: jest.fn().mockReturnValue('http://localhost:3000'),
}));

jest.mock('./lnbits.api', () => ({
  createLnbitsInvoice: jest.fn(),
}));

jest.mock('../test/test-item.util', () => ({
  normalizedTestId: jest.fn().mockImplementation((test: any) => test.id),
  workspaceRoot: jest.fn().mockReturnValue('/mock/workspace'),
}));

import {
  fetchBounties,
  createBounty,
  checkPaidStatus,
  updatePaidStatus,
  claimBountyWithLnAddress,
  deactivateBounty,
  setBountyCreator,
  approveClaim,
} from './bounty.api.js';

describe('fetchBounties', () => {
  it('fetches all bounties and prepends workspace root', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        bounties: [
          { testId: '/src/foo.test.ts#test1', amountSats: 1000 },
          { testId: 'src/bar.test.ts#test2', amountSats: 2000 },
        ],
      }),
    } as any);

    const result = await fetchBounties();
    expect(result).toHaveLength(2);
    expect(result[0].testId).toBe('/mock/workspace/src/foo.test.ts#test1');
    expect(result[1].testId).toBe('/mock/workspace/src/bar.test.ts#test2');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        href: expect.stringContaining('/bounties'),
      }),
      {}
    );
  });

  it('appends testId filter when provided', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ bounties: [] }),
    } as any);

    await fetchBounties({ testId: 'my-test-id' });
    const callUrl = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(callUrl.toString()).toContain('testId=my-test-id');
  });

  it('appends includeInactive when true', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ bounties: [] }),
    } as any);

    await fetchBounties({ includeInactive: true });
    const callUrl = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(callUrl.toString()).toContain('includeInactive=true');
  });

  it('returns empty array and shows error on non-OK response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
    } as any);

    const result = await fetchBounties();
    expect(result).toEqual([]);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Failed to load bounties from backend'
    );
  });

  it('returns empty array on network error', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));

    const result = await fetchBounties();
    expect(result).toEqual([]);
    // The toast is rate-limited (10s cooldown) and the prior failure case in
    // this suite already burned the window, so we only assert the empty-array
    // contract here, not the toast.
  });

  it('normalizes a missing `claims` field to an empty array', async () => {
    // Backend can return bounties without a `claims` field — the claim flow
    // and code-lens both index into it, so we need an array here, not undefined.
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        bounties: [{ testId: '/foo.test.ts#t', amountSats: 1000 /* no claims */ }],
      }),
    } as any);

    const [bounty] = await fetchBounties();
    expect(Array.isArray(bounty.claims)).toBe(true);
    expect(bounty.claims).toEqual([]);
  });

  it('returns empty array when response has no bounties field', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as any);

    const result = await fetchBounties();
    expect(result).toEqual([]);
  });

  it('appends repo query param when provided', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ bounties: [] }),
    } as any);

    await fetchBounties({ repo: 'owner/repo' });
    const callUrl = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(callUrl.toString()).toContain('repo=owner%2Frepo');
  });

  it('POSTs to /bounties/filter when testIds provided', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ bounties: [] }),
    } as any);

    await fetchBounties({ testIds: ['/src/foo.test.ts#test1'], repo: 'owner/repo' });
    const [callUrl, callOpts] = (global.fetch as jest.Mock).mock.calls[0];
    expect(callUrl.toString()).toContain('/bounties/filter');
    expect(callUrl.toString()).toContain('repo=owner%2Frepo');
    expect(callOpts.method).toBe('POST');
    expect(JSON.parse(callOpts.body)).toEqual({ testIds: ['/src/foo.test.ts#test1'] });
  });

  it('chunks testIds into 500-entry batches when over the cap', async () => {
    // Backend's /bounties/filter rejects > 500 testIds per request. Verify
    // we split into chunks, hit POST once per chunk, and de-duplicate the
    // merged result by bounty id.
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (_url, init: any) => {
      const body = JSON.parse(init.body) as { testIds: string[] };
      // Echo a single bounty per request so we can count chunks.
      return {
        ok: true,
        json: async () => ({
          bounties: [
            {
              id: `b-${body.testIds[0]}`,
              testId: body.testIds[0],
              amountSats: 1000,
            },
          ],
        }),
      } as any;
    });

    const ids = Array.from({ length: 1100 }, (_, i) => `/t${i}.test.ts#x`);
    const result = await fetchBounties({ testIds: ids });

    // 1100 / 500 = 3 chunks (500 + 500 + 100)
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(3); // one bounty per chunk
    // First chunk's first id is t0; second chunk's is t500; third is t1000.
    const ids2 = result.map((b) => b.testId).sort();
    expect(ids2).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/t0.test.ts'),
        expect.stringContaining('/t500.test.ts'),
        expect.stringContaining('/t1000.test.ts'),
      ])
    );
  });

  it('does not chunk when testIds fits under the cap', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ bounties: [] }),
    } as any);

    await fetchBounties({ testIds: Array.from({ length: 500 }, (_, i) => `/t${i}#x`) });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('uses GET without testIds', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ bounties: [] }),
    } as any);

    await fetchBounties({ repo: 'owner/repo' });
    const [, callOpts] = (global.fetch as jest.Mock).mock.calls[0];
    expect(callOpts).toEqual({});
  });
});

describe('createBounty', () => {
  const mockTest = {
    id: 'test-123',
    label: 'my test',
    uri: { fsPath: '/mock/workspace/foo.test.ts' },
  } as any;

  it('creates invoice from LNbits when apiKey provided without url', async () => {
    const { createLnbitsInvoice } = require('./lnbits.api');
    (createLnbitsInvoice as jest.Mock).mockResolvedValue({
      payment_request: 'lnbc_from_lnbits',
      payment_hash: 'hash_from_lnbits',
    });

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'bounty-uuid', testId: 'test-123' }),
    } as any);

    // lnbitsUrl is falsy (''), but apiKey is provided
    const result = await createBounty(5000, '', 'my-api-key', mockTest, 'creator');
    // The body should include the invoice from LNbits
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.frontEndInvoice).toBe('lnbc_from_lnbits');
    expect(body.frontEndPaymentHash).toBe('hash_from_lnbits');
  });

  it('creates bounty via POST and returns result', async () => {
    const mockBounty = {
      id: 'bounty-uuid',
      testId: 'test-123',
      amountSats: 5000,
      invoice: 'lnbc5000...',
      paymentHash: 'hash123',
    };
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => mockBounty,
    } as any);

    const result = await createBounty(5000, undefined, undefined, mockTest, 'creator-pub');
    expect(result).toEqual(mockBounty);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/bounties',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"amountSats":5000'),
      })
    );
  });

  it('returns undefined and shows error on non-OK response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ message: 'Bad request' }),
    } as any);

    const result = await createBounty(5000, undefined, undefined, mockTest, 'creator-pub');
    expect(result).toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Failed to create bounty in backend'
    );
  });

  it('returns undefined on network error', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));

    const result = await createBounty(5000, undefined, undefined, mockTest, 'creator-pub');
    expect(result).toBeUndefined();
  });

  it('normalizes a missing `claims` field on the returned bounty', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'bounty-uuid', testId: 'test-123' /* no claims */ }),
    } as any);

    const result = await createBounty(5000, undefined, undefined, mockTest, 'creator-pub');
    expect(result?.claims).toEqual([]);
  });

  it('falls back to status when error body has no message', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({}),
    } as any);

    const result = await createBounty(5000, undefined, undefined, mockTest, 'creator-pub');
    expect(result).toBeUndefined();
  });

  it('omits fundingMode from POST body when default (custodial)', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'bounty-uuid' }),
    } as any);

    await createBounty(5000, undefined, undefined, mockTest, 'creator-pub');
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    // Backward-compat: older backends shouldn't see an unknown field.
    expect(body.fundingMode).toBeUndefined();
  });

  it('skips LNbits invoice creation when fundingMode is nwc', async () => {
    const { createLnbitsInvoice } = require('./lnbits.api');
    (createLnbitsInvoice as jest.Mock).mockClear();

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'bounty-uuid', fundingMode: 'nwc' }),
    } as any);

    await createBounty(5000, '', 'my-api-key', mockTest, 'creator-pub', undefined, 'nwc');

    // No invoice minted for NWC — sats stay in the creator's wallet.
    expect(createLnbitsInvoice).not.toHaveBeenCalled();
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.fundingMode).toBe('nwc');
    expect(body.frontEndInvoice).toBe('');
    expect(body.frontEndPaymentHash).toBe('');
  });

  it('forwards repo when provided alongside fundingMode', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'bounty-uuid' }),
    } as any);

    await createBounty(5000, undefined, undefined, mockTest, 'creator-pub', 'owner/repo', 'nwc');
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.repo).toBe('owner/repo');
    expect(body.fundingMode).toBe('nwc');
  });
});

describe('checkPaidStatus', () => {
  it('returns paid status when response is OK', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ paid: true }),
    } as any);

    const result = await checkPaidStatus('hash123');
    expect(result).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/bounties/hash123/check-paid',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('returns false when not paid', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ paid: false }),
    } as any);

    const result = await checkPaidStatus('hash456');
    expect(result).toBe(false);
  });

  it('returns false on non-OK response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Server error',
    } as any);

    const result = await checkPaidStatus('hash789');
    expect(result).toBe(false);
  });

  it('returns false on network error', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('timeout'));

    const result = await checkPaidStatus('hash000');
    expect(result).toBe(false);
  });

  it('encodes paymentHash in URL', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ paid: true }),
    } as any);

    await checkPaidStatus('hash/with/slashes');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/bounties/hash%2Fwith%2Fslashes/check-paid',
      expect.anything()
    );
  });
});

describe('updatePaidStatus', () => {
  it('returns true on success', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
    } as any);

    const result = await updatePaidStatus('bounty-id-1');
    expect(result).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/bounties/bounty-id-1/update-paid',
      expect.objectContaining({ method: 'PATCH' })
    );
  });

  it('returns false and shows error on non-OK response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'Not found',
    } as any);

    const result = await updatePaidStatus('bounty-id-1');
    expect(result).toBe(false);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to sync payment status')
    );
  });

  it('returns false on network error', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));

    const result = await updatePaidStatus('bounty-id-1');
    expect(result).toBe(false);
  });
});

describe('claimBountyWithLnAddress', () => {
  it('returns claim info on success', async () => {
    const claimData = { id: 'claim-1', status: 'pending', claimantLnurl: 'user@example.com' };
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => claimData,
    } as any);

    const result = await claimBountyWithLnAddress('bounty-id', 'user@example.com');
    expect(result).toEqual(claimData);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/bounties/bounty-id/claim',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"lnurl":"user@example.com"'),
      })
    );
  });

  it('trims whitespace from lnurl', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as any);

    await claimBountyWithLnAddress('bounty-id', '  user@example.com  ');
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.lnurl).toBe('user@example.com');
  });

  it('returns null and shows error on non-OK response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Invalid LNURL',
    } as any);

    const result = await claimBountyWithLnAddress('bounty-id', 'bad-lnurl');
    expect(result).toBeNull();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to claim bounty')
    );
  });

  it('returns null on network error', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));

    const result = await claimBountyWithLnAddress('bounty-id', 'user@example.com');
    expect(result).toBeNull();
  });
});

describe('deactivateBounty', () => {
  it('no-refund path: sends no body, returns {success: true}', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as any);

    const result = await deactivateBounty('bounty-uuid');
    expect(result).toEqual({ success: true, refund: undefined });
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:3000/bounties/bounty-uuid/deactivate',
      expect.objectContaining({ method: 'PATCH' })
    );
    // No body sent when refundLnurl is omitted
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.body).toBeUndefined();
  });

  it('refund path: sends refundLnurl body, returns refund info', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        refund: { checkingId: 'chk-1', amountSats: 1000 },
      }),
    } as any);

    const result = await deactivateBounty('bounty-uuid', 'alice@primal.net');
    expect(result).toEqual({
      success: true,
      refund: { checkingId: 'chk-1', amountSats: 1000 },
    });
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.body).toBe(JSON.stringify({ refundLnurl: 'alice@primal.net' }));
  });

  it('returns {success: false} on non-OK response and surfaces backend error', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Already refunded' }),
    } as any);

    const result = await deactivateBounty('bounty-uuid', 'alice@primal.net');
    expect(result).toEqual({ success: false });
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Already refunded')
    );
  });

  it('returns {success: false} on network error', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));

    const result = await deactivateBounty('bounty-uuid');
    expect(result).toEqual({ success: false });
  });

  it('combines errorData.error + dev-mode message when both present', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        error: 'Failed to deactivate bounty',
        message: 'LNbits payout error: 520',
      }),
    } as any);

    await deactivateBounty('bounty-uuid', 'alice@primal.net');
    // Frontend prefers `${error}: ${message}` so the user sees the real cause.
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to deactivate bounty: LNbits payout error: 520')
    );
  });

  it('skips dev-mode message when it is the generic "Internal server error"', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        error: 'Some specific error',
        message: 'Internal server error',
      }),
    } as any);

    await deactivateBounty('bounty-uuid');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Some specific error')
    );
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('Internal server error')
    );
  });

  it('falls back to status when JSON body has neither error nor message', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as any);

    await deactivateBounty('bounty-uuid');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('503')
    );
  });

  it('falls back to status when body is not JSON', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
    } as any);

    await deactivateBounty('bounty-uuid');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('502')
    );
  });

  it('treats success body without success field as successful', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as any);

    const result = await deactivateBounty('bounty-uuid');
    // success defaults to true when the field is absent — keeps the existing
    // contract that a 2xx response without a body still means "deactivated".
    expect(result).toEqual({ success: true, refund: undefined });
  });

  it('returns {success: true} when success body is not JSON', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error('not json');
      },
    } as any);

    const result = await deactivateBounty('bounty-uuid');
    expect(result).toEqual({ success: true, refund: undefined });
  });
});

describe('setBountyCreator', () => {
  it('returns updated bounty on success', async () => {
    const updatedBounty = { id: 'bounty-1', creatorId: 'npub123' };
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => updatedBounty,
    } as any);

    const result = await setBountyCreator('bounty-1', '  npub123  ');
    expect(result).toEqual(updatedBounty);

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.creatorId).toBe('npub123'); // trimmed
  });

  it('returns null on non-OK response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'Not found',
    } as any);

    const result = await setBountyCreator('bounty-1', 'npub123');
    expect(result).toBeNull();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to set creator')
    );
  });

  it('returns null on network error', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));

    const result = await setBountyCreator('bounty-1', 'npub123');
    expect(result).toBeNull();
  });
});

describe('approveClaim', () => {
  it('returns updated bounty on success', async () => {
    const updated = { id: 'bounty-1', claims: [{ status: 'approved' }] };
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => updated,
    } as any);

    const result = await approveClaim('bounty-1', '  approver-pub  ');
    expect(result).toEqual(updated);

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.approvedBy).toBe('approver-pub'); // trimmed
  });

  it('returns null on non-OK response with JSON error', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ message: 'Not authorized' }),
    } as any);

    const result = await approveClaim('bounty-1', 'approver-pub');
    expect(result).toBeNull();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to approve claim')
    );
  });

  it('returns null on non-OK response with non-JSON error', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    } as any);

    const result = await approveClaim('bounty-1', 'approver-pub');
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));

    const result = await approveClaim('bounty-1', 'approver-pub');
    expect(result).toBeNull();
  });
});
