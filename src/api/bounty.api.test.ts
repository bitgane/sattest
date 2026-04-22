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
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Failed to load bounties from backend'
    );
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
  it('returns true on success', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
    } as any);

    const result = await deactivateBounty('bounty-uuid');
    expect(result).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/bounties/bounty-uuid/deactivate',
      expect.objectContaining({ method: 'PATCH' })
    );
  });

  it('returns false on non-OK response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    } as any);

    const result = await deactivateBounty('bounty-uuid');
    expect(result).toBe(false);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to deactivate bounty')
    );
  });

  it('returns false on network error', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));

    const result = await deactivateBounty('bounty-uuid');
    expect(result).toBe(false);
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
