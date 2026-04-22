import * as vscode from 'vscode';
import {
  addBountyCommand,
  removeBountyCommand,
  checkPaidCommand,
  claimBountyCommand,
  approveClaimCommand,
  getWalletId,
} from './bounty.util.js';
import { BountyInfo, ClaimInfo, ClaimStatus } from './bounty.types.js';
import {
  createBounty as createBountyApi,
  checkPaidStatus,
  updatePaidStatus,
  claimBountyWithLnAddress,
  deactivateBounty,
  approveClaim as approveClaimApi,
} from '../api/bounty.api.js';
import { getNostrUserPubkey } from '../state.js';

jest.mock('qrcode', () => ({
  toString: jest.fn((text: string, options: any, cb: any) => cb(null, '<svg>fake-qr</svg>')),
}));

jest.mock('../api/nostr-auth', () => ({
  getNostrAuthHeaders: jest.fn().mockImplementation(async (extra?: Record<string, string>) => ({
    Authorization: 'Nostr dGVzdC1hdXRoLWV2ZW50',
    ...extra,
  })),
}));

jest.mock('../api/nostr.api', () => ({
  connectNostr: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../state', () => ({
  getNostrUserPubkey: jest.fn().mockResolvedValue('creator-pubkey'),
  getNostrUserHandle: jest.fn().mockResolvedValue('@alice'),
  getNostrRelays: jest.fn().mockReturnValue([]),
  getIsDefaultLnbits: jest.fn().mockResolvedValue(true),
  setIsDefaultLnbits: jest.fn().mockResolvedValue(undefined),
  initializeSecrets: jest.fn(),
}));

jest.mock('../api/lnbits.api', () => ({
  getLnbitsConfig: jest.fn().mockResolvedValue(null),
  configureLnbits: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../api/bounty.api', () => ({
  createBounty: jest.fn(),
  checkPaidStatus: jest.fn(),
  updatePaidStatus: jest.fn(),
  claimBountyWithLnAddress: jest.fn(),
  deactivateBounty: jest.fn(),
  setBountyCreator: jest.fn(),
  approveClaim: jest.fn(),
}));

jest.mock('../test/test-item.util', () => ({
  normalizedTestId: jest.fn().mockImplementation((test: any) => test.id),
  removeParentLabelFromTestId: jest.fn().mockImplementation((test: any) => test.id),
}));

// Helpers
function createMockTestItem(overrides: Partial<vscode.TestItem> = {}): vscode.TestItem {
  return {
    id: 'test-id-123',
    label: 'should do something',
    uri: vscode.Uri.file('/fake/path.test.ts'),
    range: new vscode.Range(10, 0, 10, 10),
    ...overrides,
  } as vscode.TestItem;
}

function createMockContext(
  overrides: Partial<vscode.ExtensionContext> = {}
): vscode.ExtensionContext {
  return {
    globalState: {
      get: jest.fn().mockReturnValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      keys: jest.fn().mockReturnValue([]),
      setKeysForSync: jest.fn(),
    },
    secrets: {
      get: jest.fn().mockResolvedValue(undefined),
      store: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    subscriptions: [],
    extensionPath: '',
    asAbsolutePath: jest.fn((path: string) => path),
    storagePath: '',
    globalStoragePath: '',
    logPath: '',
    ...overrides,
  } as unknown as vscode.ExtensionContext;
}

describe('addBountyCommand', () => {
  let bounties: Map<string, BountyInfo>;
  let mockEmitter: { fire: jest.Mock };
  let capturedHandler: ((test?: vscode.TestItem) => Promise<void>) | undefined;

  beforeEach(() => {
    bounties = new Map();
    mockEmitter = { fire: jest.fn() } as any;

    jest.spyOn(vscode.commands, 'registerCommand').mockImplementation((id, handler) => {
      capturedHandler = handler as any;
      return { dispose: jest.fn() } as any;
    });
  });

  it('shows error when no test item is provided', async () => {
    const mockContext = createMockContext();
    addBountyCommand(bounties, mockEmitter as any, mockContext);
    await capturedHandler!(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No test selected');
  });

  it('shows warning if bounty already exists', async () => {
    const mockTestItem = createMockTestItem();
    const mockContext = createMockContext();

    bounties.set(mockTestItem.id, {
      amountSats: 5000,
      invoice: 'lnbc...',
      createdAt: new Date(),
      testId: mockTestItem.id,
    } as BountyInfo);

    addBountyCommand(bounties, mockEmitter as any, mockContext);
    await capturedHandler!(mockTestItem);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('already has 5000 sats bounty')
    );
  });

  it('creates bounty with valid sats input', async () => {
    const mockContext = createMockContext();
    const mockTestItem = createMockTestItem({ id: 'test-456' });

    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('15000');

    (createBountyApi as jest.Mock).mockResolvedValue({
      id: 'bounty-uuid',
      testId: 'test-456',
      amountSats: 15000,
      invoice: 'lnbc15000...',
      paymentHash: 'hash_123',
      createdAt: new Date().toISOString(),
    });

    addBountyCommand(bounties, mockEmitter as any, mockContext);
    await capturedHandler!(mockTestItem);

    expect(bounties.size).toBe(1);
    expect(bounties.get('test-456')?.amountSats).toBe(15000);
    expect(mockEmitter.fire).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Bounty created: 15000 sats')
    );
  });

  it('does nothing when user cancels amount input', async () => {
    const mockContext = createMockContext();
    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce(undefined);

    addBountyCommand(bounties, mockEmitter as any, mockContext);
    await capturedHandler!(createMockTestItem());

    expect(bounties.size).toBe(0);
    expect(mockEmitter.fire).not.toHaveBeenCalled();
  });

  it('shows error when nostr pubkey not configured and connect fails', async () => {
    const mockContext = createMockContext();
    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('1000');
    (getNostrUserPubkey as jest.Mock)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    addBountyCommand(bounties, mockEmitter as any, mockContext);
    await capturedHandler!(createMockTestItem());

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Nostr reviewer not configured.');
  });

  it('shows LNbits choice when isDefaultLnbits is false', async () => {
    const mockContext = createMockContext();
    const mockTestItem = createMockTestItem({ id: 'test-lnbits' });
    const { getIsDefaultLnbits, setIsDefaultLnbits } = require('../state');
    const { getLnbitsConfig, configureLnbits } = require('../api/lnbits.api');

    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('5000');
    (getIsDefaultLnbits as jest.Mock).mockResolvedValue(false);
    (getLnbitsConfig as jest.Mock).mockResolvedValue(null);

    // User picks default
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValueOnce(
      'Use default (easiest)'
    );

    (createBountyApi as jest.Mock).mockResolvedValue({
      id: 'bounty-uuid',
      testId: 'test-lnbits',
      amountSats: 5000,
      invoice: 'lnbc...',
      paymentHash: 'hash',
    });

    addBountyCommand(bounties, mockEmitter as any, mockContext);
    await capturedHandler!(mockTestItem);

    expect(setIsDefaultLnbits).toHaveBeenCalled();
    expect(bounties.size).toBe(1);
  });

  it('shows LNbits choice - user picks own LNbits then aborts', async () => {
    const mockContext = createMockContext();
    const mockTestItem = createMockTestItem({ id: 'test-lnbits2' });
    const { getIsDefaultLnbits } = require('../state');
    const { getLnbitsConfig, configureLnbits } = require('../api/lnbits.api');

    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('5000');
    (getIsDefaultLnbits as jest.Mock).mockResolvedValue(false);
    (getLnbitsConfig as jest.Mock)
      .mockResolvedValueOnce(null) // initial check
      .mockResolvedValueOnce(null); // after configureLnbits (user didn't complete)

    // User picks own LNbits
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValueOnce('Use my own LNbits');
    (configureLnbits as jest.Mock).mockResolvedValue(undefined);

    addBountyCommand(bounties, mockEmitter as any, mockContext);
    await capturedHandler!(mockTestItem);

    expect(configureLnbits).toHaveBeenCalled();
    // Should show info about LNbits being required
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Lnbits info is required')
    );
    expect(bounties.size).toBe(0);
  });

  it('handles createBounty API failure', async () => {
    const mockContext = createMockContext();
    const mockTestItem = createMockTestItem({ id: 'test-err' });

    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('1000');
    (createBountyApi as jest.Mock).mockRejectedValue(new Error('Backend offline'));

    addBountyCommand(bounties, mockEmitter as any, mockContext);
    await capturedHandler!(mockTestItem);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to create bounty')
    );
  });

  it('updates creator when pubkey changes after bounty creation', async () => {
    const mockContext = createMockContext();
    const mockTestItem = createMockTestItem({ id: 'test-creator' });

    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('2000');
    (getNostrUserPubkey as jest.Mock)
      .mockResolvedValueOnce('initial-pubkey') // line 86: sets userNostrPubkey
      .mockResolvedValueOnce('new-pubkey'); // line 148: sets userPubkey (different!)

    (createBountyApi as jest.Mock).mockResolvedValue({
      id: 'bounty-uuid',
      testId: 'test-creator',
      amountSats: 2000,
      invoice: 'lnbc...',
      paymentHash: 'hash',
    });

    const { setBountyCreator } = require('../api/bounty.api');
    (setBountyCreator as jest.Mock).mockResolvedValue({
      id: 'bounty-uuid',
      creatorId: 'new-pubkey',
    });

    addBountyCommand(bounties, mockEmitter as any, mockContext);
    await capturedHandler!(mockTestItem);

    expect(setBountyCreator).toHaveBeenCalledWith('bounty-uuid', 'new-pubkey');
  });
});

describe('removeBountyCommand', () => {
  let capturedHandler: ((test?: vscode.TestItem) => Promise<void>) | undefined;

  beforeEach(() => {
    jest.spyOn(vscode.commands, 'registerCommand').mockImplementation((id, handler) => {
      if (id === 'sattest.removeBounty') {
        capturedHandler = handler as any;
      }
      return { dispose: jest.fn() } as any;
    });
  });

  it('shows error when no test item is provided', async () => {
    const bounties = new Map<string, BountyInfo>();
    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = createMockContext();

    removeBountyCommand(bounties, mockEmitter, mockContext);
    await capturedHandler!(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No test selected');
  });

  it('shows message when no bounty exists', async () => {
    const bounties = new Map<string, BountyInfo>();
    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = createMockContext();

    removeBountyCommand(bounties, mockEmitter, mockContext);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('No bounty on test')
    );
  });

  it('removes bounty after confirmation', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      id: 'bounty-uuid',
      amountSats: 10000,
      invoice: 'lnbc...',
      testId: 'test-id',
      creatorId: 'creator-pubkey',
      claims: [] as ClaimInfo[],
    } as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = createMockContext();

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, Remove');
    (deactivateBounty as jest.Mock).mockResolvedValue(true);

    removeBountyCommand(bounties, mockEmitter, mockContext);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(bounties.size).toBe(0);
    expect(mockEmitter.fire).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Bounty removed')
    );
  });

  it('does nothing if user cancels removal', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      id: 'bounty-uuid',
      amountSats: 10000,
      testId: 'test-id',
      creatorId: 'creator-pubkey',
    } as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = createMockContext();

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

    removeBountyCommand(bounties, mockEmitter, mockContext);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(bounties.size).toBe(1);
    expect(mockEmitter.fire).not.toHaveBeenCalled();
  });

  it('blocks non-creator from removing bounty', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      id: 'bounty-uuid',
      amountSats: 10000,
      testId: 'test-id',
      creatorId: 'other-pubkey',
    } as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = createMockContext();

    removeBountyCommand(bounties, mockEmitter, mockContext);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Not authorized to remove this bounty'
    );
    expect(bounties.size).toBe(1);
  });

  it('handles deactivation throwing an error', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      id: 'bounty-uuid',
      amountSats: 10000,
      testId: 'test-id',
      creatorId: 'creator-pubkey',
    } as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = createMockContext();

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, Remove');
    (deactivateBounty as jest.Mock).mockRejectedValue(new Error('Network error'));

    removeBountyCommand(bounties, mockEmitter, mockContext);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(bounties.size).toBe(1);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to deactivate bounty')
    );
  });

  it('does not remove when deactivation fails', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      id: 'bounty-uuid',
      amountSats: 10000,
      testId: 'test-id',
      creatorId: 'creator-pubkey',
    } as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = createMockContext();

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, Remove');
    (deactivateBounty as jest.Mock).mockResolvedValue(false);

    removeBountyCommand(bounties, mockEmitter, mockContext);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(bounties.size).toBe(1);
  });
});

describe('checkPaidCommand', () => {
  let capturedHandler: ((test?: vscode.TestItem) => Promise<void>) | undefined;

  beforeEach(() => {
    jest.spyOn(vscode.commands, 'registerCommand').mockImplementation((id, handler) => {
      if (id === 'sattest.checkPaid') {
        capturedHandler = handler as any;
      }
      return { dispose: jest.fn() } as any;
    });
  });

  it('shows error when no test item is provided', async () => {
    const bounties = new Map<string, BountyInfo>();
    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = createMockContext();

    checkPaidCommand(bounties, mockEmitter, mockContext);
    await capturedHandler!(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No test selected');
  });

  it('shows info when no bounty or payment hash', async () => {
    const bounties = new Map<string, BountyInfo>();
    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = createMockContext();

    checkPaidCommand(bounties, mockEmitter, mockContext);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'No bounty or payment hash for this test'
    );
  });

  it('shows info for bounty with no payment hash', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      amountSats: 5000,
      testId: 'test-id',
      paymentHash: undefined,
    } as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = createMockContext();

    checkPaidCommand(bounties, mockEmitter, mockContext);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'No bounty or payment hash for this test'
    );
  });

  it('marks bounty as funded when payment detected', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      id: 'bounty-uuid',
      amountSats: 5000,
      paymentHash: 'hash123',
      testId: 'test-id',
      invoicePaid: false,
    } as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = createMockContext();

    (checkPaidStatus as jest.Mock).mockResolvedValue(true);
    (updatePaidStatus as jest.Mock).mockResolvedValue(true);

    checkPaidCommand(bounties, mockEmitter, mockContext);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(bounties.get('test-id')?.invoicePaid).toBe(true);
    expect(mockEmitter.fire).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Bounty funded!')
    );
  });

  it('shows not funded message and opens QR panel', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      id: 'bounty-uuid',
      amountSats: 5000,
      paymentHash: 'hash123',
      invoice: 'lnbc5000...',
      testId: 'test-id',
      invoicePaid: false,
    } as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = createMockContext();

    (checkPaidStatus as jest.Mock).mockResolvedValue(false);

    checkPaidCommand(bounties, mockEmitter, mockContext);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('not yet funded')
    );
  });

  it('handles check-paid error gracefully', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      id: 'bounty-uuid',
      amountSats: 5000,
      paymentHash: 'hash123',
      testId: 'test-id',
    } as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = createMockContext();

    (checkPaidStatus as jest.Mock).mockRejectedValue(new Error('Network error'));

    checkPaidCommand(bounties, mockEmitter, mockContext);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Error checking payment')
    );
  });
});

describe('claimBountyCommand', () => {
  let capturedHandler: ((test?: vscode.TestItem) => Promise<void>) | undefined;

  beforeEach(() => {
    jest.spyOn(vscode.commands, 'registerCommand').mockImplementation((id, handler) => {
      if (id === 'sattest.claimBounty') {
        capturedHandler = handler as any;
      }
      return { dispose: jest.fn() } as any;
    });
  });

  it('shows error when no test item is provided', async () => {
    const bounties = new Map<string, BountyInfo>();
    const mockEmitter = { fire: jest.fn() } as any;

    claimBountyCommand(bounties, mockEmitter);
    await capturedHandler!(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No test selected');
  });

  it('shows error when bounty not funded or already claimed', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      amountSats: 5000,
      testId: 'test-id',
      invoicePaid: false,
      claims: [] as ClaimInfo[],
    } as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;

    claimBountyCommand(bounties, mockEmitter);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Bounty not funded yet or already claimed'
    );
  });

  it('does nothing if user cancels lnurl input', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      amountSats: 10000,
      invoicePaid: true,
      claims: [{} as ClaimInfo],
      testId: 'test-id',
    } as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;

    claimBountyCommand(bounties, mockEmitter);

    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce(undefined);

    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(bounties.get('test-id')!.claims[0].status).toBeUndefined();
  });

  it('submits claim and sets pending status', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      id: 'bounty-uuid',
      amountSats: 10000,
      invoicePaid: true,
      claims: [{} as ClaimInfo],
      testId: 'test-id',
    } as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;

    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('alice@primal.net');
    (claimBountyWithLnAddress as jest.Mock).mockResolvedValue({ status: 'pending' });

    claimBountyCommand(bounties, mockEmitter);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(claimBountyWithLnAddress).toHaveBeenCalledWith('bounty-uuid', 'alice@primal.net');
    expect(bounties.get('test-id')!.claims[0].status).toBe('pending');
    expect(mockEmitter.fire).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Claim request sent')
    );
  });

  it('handles claim API error', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      id: 'bounty-uuid',
      amountSats: 10000,
      invoicePaid: true,
      claims: [{} as ClaimInfo],
      testId: 'test-id',
    } as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;

    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('alice@primal.net');
    (claimBountyWithLnAddress as jest.Mock).mockRejectedValue(new Error('Server error'));

    claimBountyCommand(bounties, mockEmitter);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to claim bounty')
    );
  });
});

describe('approveClaimCommand', () => {
  let capturedHandler: ((test?: vscode.TestItem) => Promise<void>) | undefined;

  beforeEach(() => {
    jest.spyOn(vscode.commands, 'registerCommand').mockImplementation((id, handler) => {
      if (id === 'sattest.approveClaim') {
        capturedHandler = handler as any;
      }
      return { dispose: jest.fn() } as any;
    });
  });

  it('shows error when no test item is provided', async () => {
    const bounties = new Map<string, BountyInfo>();
    const mockEmitter = { fire: jest.fn() } as any;

    approveClaimCommand(bounties, mockEmitter);
    await capturedHandler!(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No test selected');
  });

  it('shows error when bounty not found', async () => {
    const bounties = new Map<string, BountyInfo>();
    const mockEmitter = { fire: jest.fn() } as any;

    approveClaimCommand(bounties, mockEmitter);
    await capturedHandler!(createMockTestItem({ id: 'unknown-test' }));

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Bounty not found');
  });

  it('finds bounty via parent fallback when direct lookup fails', async () => {
    (getNostrUserPubkey as jest.Mock).mockResolvedValue('creator-pubkey');
    const bounties = new Map<string, BountyInfo>();
    // Store bounty under the parent-stripped ID
    bounties.set('test-id', {
      id: 'bounty-uuid',
      amountSats: 10000,
      testId: 'test-id',
      creatorId: 'creator-pubkey',
      claims: [{ status: 'pending' as ClaimStatus }],
    } as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;
    const { removeParentLabelFromTestId } = require('../test/test-item.util');
    (removeParentLabelFromTestId as jest.Mock).mockReturnValue('test-id');

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, Approve Payout');
    (approveClaimApi as jest.Mock).mockResolvedValue({ id: 'bounty-uuid' });

    approveClaimCommand(bounties, mockEmitter);
    // Use a test item with parent - direct lookup with 'child-test-id' fails,
    // but parent fallback returns 'test-id'
    await capturedHandler!(
      createMockTestItem({
        id: 'child-test-id',
        parent: { id: 'parent' } as any,
      })
    );

    expect(approveClaimApi).toHaveBeenCalledWith('bounty-uuid', 'creator-pubkey');
  });

  it('blocks non-creator from approving', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      id: 'bounty-uuid',
      amountSats: 10000,
      testId: 'test-id',
      creatorId: 'other-pubkey',
      claims: [{ status: 'pending' as ClaimStatus }],
    } as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;
    (getNostrUserPubkey as jest.Mock).mockResolvedValue('my-pubkey');

    approveClaimCommand(bounties, mockEmitter);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Not authorized to approve this claim'
    );
  });

  it('does nothing if user cancels approval', async () => {
    (getNostrUserPubkey as jest.Mock).mockResolvedValue('creator-pubkey');
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      id: 'bounty-uuid',
      amountSats: 10000,
      testId: 'test-id',
      creatorId: 'creator-pubkey',
      claims: [{ status: 'pending' as ClaimStatus }],
    } as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Cancel');

    approveClaimCommand(bounties, mockEmitter);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(approveClaimApi).not.toHaveBeenCalled();
  });

  it('approves claim and updates bounty status', async () => {
    (getNostrUserPubkey as jest.Mock).mockResolvedValue('creator-pubkey');
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      id: 'bounty-uuid',
      amountSats: 10000,
      testId: 'test-id',
      creatorId: 'creator-pubkey',
      claims: [{ status: 'pending' as ClaimStatus }],
    } as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, Approve Payout');
    (approveClaimApi as jest.Mock).mockResolvedValue({
      id: 'bounty-uuid',
      claims: [{ status: 'approved' }],
    });

    approveClaimCommand(bounties, mockEmitter);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(approveClaimApi).toHaveBeenCalledWith('bounty-uuid', 'creator-pubkey');
    expect(bounties.get('test-id')!.claims[0].status).toBe('approved');
    expect(mockEmitter.fire).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Claim approved – payout triggered!'
    );
  });

  it('handles approval API error', async () => {
    (getNostrUserPubkey as jest.Mock).mockResolvedValue('creator-pubkey');
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      id: 'bounty-uuid',
      amountSats: 10000,
      testId: 'test-id',
      creatorId: 'creator-pubkey',
      claims: [{ status: 'pending' as ClaimStatus }],
    } as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, Approve Payout');
    (approveClaimApi as jest.Mock).mockRejectedValue(new Error('Server error'));

    approveClaimCommand(bounties, mockEmitter);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Approval error')
    );
  });
});

describe('getWalletId', () => {
  it('returns wallet ID on success', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'wallet-123' }),
    } as any);

    const id = await getWalletId('https://lnbits.example.com', 'key-abc');
    expect(id).toBe('wallet-123');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://lnbits.example.com/api/v1/wallet',
      expect.objectContaining({
        headers: { 'X-Api-Key': 'key-abc' },
      })
    );
  });

  it('returns undefined on non-OK response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
    } as any);

    const id = await getWalletId('https://lnbits.example.com', 'bad-key');
    expect(id).toBeUndefined();
  });

  it('returns undefined on network error', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));

    const id = await getWalletId('https://lnbits.example.com', 'key');
    expect(id).toBeUndefined();
  });
});
