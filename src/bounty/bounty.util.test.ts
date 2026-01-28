import * as vscode from 'vscode';
import {
  addBountyCommand,
  removeBountyCommand,
  checkPaidCommand,
  claimBountyCommand,
  getWalletId,
  executePayout,
} from './bounty.util';
import { BountyInfo, ClaimStatus } from './bounty.types'; // adjust path if needed
import { LNBITS_INVOICE_KEY_KEY, LNBITS_URL_KEY } from './bounty.constants';

jest.mock('qrcode', () => ({
  toString: jest.fn((text, options, cb) => cb(null, '<svg>fake-qr</svg>')),
}));

global.fetch = jest.fn();

const mockFetch = global.fetch as jest.Mock;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function createMockTestItem(overrides: Partial<vscode.TestItem> = {}): vscode.TestItem {
  return {
    id: 'test-id-123',
    label: 'should do something',
    uri: vscode.Uri.file('/fake/path.test.ts'),
    range: new vscode.Range(10, 0, 10, 10),
    ...overrides,
  } as vscode.TestItem;
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('addBountyCommand', () => {
  let onBountiesChangedEmitter: vscode.EventEmitter<void>;
  let context: vscode.ExtensionContext;
  let mockTestItem: vscode.TestItem;
  let capturedHandler: ((test?: vscode.TestItem) => Promise<void>) | undefined;

  beforeAll(() => {
    (vscode.window.createWebviewPanel as jest.Mock) = jest.fn().mockReturnValue({
      webview: {
        html: '',
        postMessage: jest.fn(),
        asWebviewUri: jest.fn(),
        onDidReceiveMessage: jest.fn(),
      },
      dispose: jest.fn(),
    } as any);

    (vscode as any).ViewColumn = {
      Active: -1,
      Beside: -2,
      One: 1,
      Two: 2,
    };
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(vscode.commands, 'registerCommand').mockImplementation((id, handler) => {
      capturedHandler = handler as any;
      return { dispose: jest.fn() } as any;
    });

    onBountiesChangedEmitter = new vscode.EventEmitter<void>();
    context = {
      globalState: {
        get: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
      },
      secrets: {
        get: jest.fn().mockResolvedValue(undefined),
        store: jest.fn().mockResolvedValue(undefined),
      },
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;
    mockTestItem = createMockTestItem();
  });

  it('should show error when no test item is provided', async () => {
    const bounties = new Map<string, BountyInfo>();
    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = {
      globalState: { get: jest.fn().mockReturnValue('http://test') },
      secrets: { get: jest.fn().mockResolvedValue('secret-key') },
    } as any;

    addBountyCommand(bounties, mockEmitter, mockContext);

    expect(capturedHandler).toBeDefined();
    await capturedHandler!(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No test selected');
  });

  it('shows warning if bounty already exists', async () => {
    const bounties = new Map<string, BountyInfo>();
    const mockEmitter = { fire: jest.fn() } as any;

    // Pre-populate with an existing bounty
    bounties.set(mockTestItem.id, {
      amountSats: 5000,
      invoice: 'lnbc...',
      createdAt: new Date(),
      testId: mockTestItem.id,
    } as BountyInfo);

    // ──── IMPORTANT: Register the command so the handler gets captured ────
    addBountyCommand(bounties, mockEmitter, context);

    // Now the handler should have been captured
    expect(capturedHandler).toBeDefined();

    // Trigger the command with the test item that already has a bounty
    await capturedHandler!(mockTestItem);

    // Verify warning message was shown
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('already has 5000 sats bounty')
    );

    // Optional: no bounty added, emitter not fired
    expect(bounties.size).toBe(1); // unchanged
    expect(mockEmitter.fire).not.toHaveBeenCalled();
  });

  it('creates bounty with valid input and new LNbits config', async () => {
    const bounties = new Map<string, BountyInfo>();
    const mockEmitter = { fire: jest.fn() } as any;

    const mockContext = createMockContext();

    // Mock the three required inputs
    (vscode.window.showInputBox as jest.Mock)
      .mockResolvedValueOnce('25000') // amount
      .mockResolvedValueOnce('http://localhost:3007') // URL
      .mockResolvedValueOnce('inv_test_key_abc123'); // Invoice key

    // Mock LNbits invoice creation
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        payment_request: 'lnbc25000fakeinvoice...',
        payment_hash: 'hash_abcdef123456',
      }),
    } as any);

    // ──── Mock the success message with button ────
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValueOnce('View All Bounties');
    //    You can also use .mockResolvedValueOnce(undefined) to simulate no selection

    // Optional: mock webview if QR panel is opened
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue({
      webview: {
        html: '',
        postMessage: jest.fn(),
        asWebviewUri: jest.fn(),
        onDidReceiveMessage: jest.fn(),
      },
      dispose: jest.fn(),
    } as any);

    addBountyCommand(bounties, mockEmitter, mockContext);

    expect(capturedHandler).toBeDefined();

    const mockTestItem = createMockTestItem({ id: 'test-id-123', label: 'Test Test' });
    await capturedHandler!(mockTestItem);

    // Main assertions
    expect(bounties.size).toBe(1);
    const bounty = bounties.get('test-id-123')!;
    expect(bounty.amountSats).toBe(25000);
    expect(bounty.invoice).toBe('lnbc25000fakeinvoice...');
    expect(bounty.paymentHash).toBe('hash_abcdef123456');
    expect(bounty.claimStatus).toBe('none');
    expect(bounty.creatorApiKey).toBe('inv_test_key_abc123');

    // Config saved
    expect(mockContext.globalState.update).toHaveBeenCalledWith(
      LNBITS_URL_KEY,
      'http://localhost:3007'
    );
    expect(mockContext.secrets.store).toHaveBeenCalledWith(
      LNBITS_INVOICE_KEY_KEY,
      'inv_test_key_abc123'
    );

    expect(mockEmitter.fire).toHaveBeenCalled();

    // Verify messages
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Bounty created: 25000 sats'),
      'View All Bounties'
    );
  });

  it('uses existing LNbits config if present', async () => {
    const bounties = new Map<string, BountyInfo>();
    const mockEmitter = { fire: jest.fn() } as any;

    const mockContext = {
      globalState: {
        get: jest.fn().mockImplementation((key: string) => {
          if (key === LNBITS_URL_KEY) {
            return 'http://existing:3007';
          }
          return undefined;
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      secrets: {
        get: jest.fn().mockImplementation((key: string) => {
          if (key === LNBITS_INVOICE_KEY_KEY) {
            return 'existing_inv_key_xyz';
          }
          return undefined;
        }),
        store: jest.fn().mockResolvedValue(undefined),
      },
    } as unknown as vscode.ExtensionContext;

    // Only mock the amount prompt (existing config → no URL/key prompts)
    (vscode.window.showInputBox as jest.Mock)
      .mockResolvedValueOnce('15000') // ← amount only
      .mockResolvedValueOnce(undefined) // safety: if code asks for more, return undefined
      .mockResolvedValueOnce(undefined);

    // Mock successful LNbits invoice creation
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        payment_request: 'lnbc15000existing...',
        payment_hash: 'hash_987654',
      }),
    } as any);

    // Mock success message (with button)
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValueOnce('View All Bounties');

    // Mock webview if QR/invoice panel is shown
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue({
      webview: { html: '', postMessage: jest.fn(), asWebviewUri: jest.fn() },
      dispose: jest.fn(),
    } as any);

    // Register the command
    addBountyCommand(bounties, mockEmitter, mockContext);

    expect(capturedHandler).toBeDefined();

    const mockTestItem = createMockTestItem({ id: 'test-id-456' });
    await capturedHandler!(mockTestItem);

    // Assertions
    expect(bounties.size).toBe(1);
    const bounty = bounties.get('test-id-456')!;
    expect(bounty.amountSats).toBe(15000);
    expect(bounty.creatorApiKey).toBe('existing_inv_key_xyz');
    expect(bounty.invoice).toBe('lnbc15000existing...');
    expect(bounty.paymentHash).toBe('hash_987654');

    // No new config should be saved
    expect(mockContext.globalState.update).not.toHaveBeenCalledWith(
      LNBITS_URL_KEY,
      expect.anything()
    );
    expect(mockContext.secrets.store).not.toHaveBeenCalled();

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('http://existing:3007/api/v1/payments'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Api-Key': 'existing_inv_key_xyz' }),
      })
    );

    expect(mockEmitter.fire).toHaveBeenCalled();
  });
});

describe('removeBountyCommand', () => {
  let capturedHandler: ((test?: vscode.TestItem) => Promise<void>) | undefined;

  beforeEach(() => {
    jest.clearAllMocks();

    // Capture the handler when registerCommand is called
    jest.spyOn(vscode.commands, 'registerCommand').mockImplementation((commandId, handler) => {
      if (commandId === 'bountyTestPlugin.removeBounty') {
        capturedHandler = handler as (test?: vscode.TestItem) => Promise<void>;
      }
      return { dispose: jest.fn() } as any;
    });

    // Reset other mocks used in the command
    (vscode.window.showWarningMessage as jest.Mock).mockReset();
    (vscode.window.showInformationMessage as jest.Mock).mockReset();
  });

  it('should show error when no test item is provided', async () => {
    const bounties = new Map<string, BountyInfo>();
    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = {
      globalState: { get: jest.fn().mockReturnValue('http://test') },
      secrets: { get: jest.fn().mockResolvedValue('secret-key') },
    } as any;

    removeBountyCommand(bounties, mockEmitter, mockContext);

    expect(capturedHandler).toBeDefined();
    await capturedHandler!(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No test selected');
  });

  it('removes existing bounty after confirmation', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      amountSats: 10000,
      invoice: 'lnbc...',
      testId: 'test-id',
    } as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;

    const mockContext = {
      globalState: {
        update: jest.fn().mockResolvedValue(undefined),
        get: jest.fn().mockReturnValue(undefined), // defensive
      },
    } as unknown as vscode.ExtensionContext;

    removeBountyCommand(bounties, mockEmitter, mockContext);

    expect(capturedHandler).toBeDefined();

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, Remove');

    const mockTestItem = createMockTestItem({ id: 'test-id' });
    await capturedHandler!(mockTestItem);

    expect(bounties.size).toBe(0);
    expect(mockContext.globalState.update).toHaveBeenCalledWith(
      'bountyTests',
      expect.any(Object) // or be more precise: Object.fromEntries(bounties)
    );
    expect(mockEmitter.fire).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Bounty removed from')
    );
  });

  it('does nothing if user cancels removal', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      amountSats: 10000,
      invoice: 'lnbc...',
      testId: 'test-id',
    } as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = {} as any;

    removeBountyCommand(bounties, mockEmitter, mockContext);

    expect(capturedHandler).toBeDefined();

    // Mock user cancels (returns undefined or different button)
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

    const mockTestItem = createMockTestItem({ id: 'test-id' });
    await capturedHandler!(mockTestItem);

    // Bounty should still exist
    expect(bounties.size).toBe(1);
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(mockEmitter.fire).not.toHaveBeenCalled();
  });

  // Bonus test: no bounty exists
  it('shows message when no bounty exists for the test', async () => {
    const bounties = new Map<string, BountyInfo>(); // empty

    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = {} as any;

    removeBountyCommand(bounties, mockEmitter, mockContext);

    const mockTestItem = createMockTestItem({ id: 'test-id' });
    await capturedHandler!(mockTestItem);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('No bounty on test')
    );
    expect(bounties.size).toBe(0);
    expect(mockEmitter.fire).not.toHaveBeenCalled();
  });
});

describe('checkPaidCommand', () => {
  let capturedHandler: ((test?: vscode.TestItem) => Promise<void>) | undefined;

  beforeEach(() => {
    jest.clearAllMocks();

    // Capture the real handler when registerCommand is called
    jest.spyOn(vscode.commands, 'registerCommand').mockImplementation((commandId, handler) => {
      if (commandId === 'bountyTestPlugin.checkPaid') {
        capturedHandler = handler as (test?: vscode.TestItem) => Promise<void>;
      }
      return { dispose: jest.fn() } as any;
    });

    // Reset mocks used inside the command
    mockFetch.mockReset();
    (vscode.window.showInformationMessage as jest.Mock).mockReset();
  });

  it('checks payment status and marks as paid when funded', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      amountSats: 5000,
      invoice: 'lnbc...',
      paymentHash: 'hash789',
      testId: 'test-id',
    } as BountyInfo);

    // Mock LNbits API response → paid = true
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ paid: true }),
    } as any);

    // Create the command → this triggers the mock and captures handler
    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = {
      globalState: { get: jest.fn().mockReturnValue('http://test') },
      secrets: { get: jest.fn().mockResolvedValue('secret-key') },
    } as any;

    checkPaidCommand(bounties, mockEmitter, mockContext);

    // Make sure handler was captured
    expect(capturedHandler).toBeDefined();

    // Call the real handler with mock test item
    const mockTestItem = createMockTestItem({ id: 'test-id' });
    await capturedHandler!(mockTestItem);

    // Assertions
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/payments/hash789'),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'X-Api-Key': 'secret-key' }),
      })
    );

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Bounty funded! 5000 sats received.')
    );

    expect(bounties.get('test-id')!.paid).toBe(true);
    expect(mockEmitter.fire).toHaveBeenCalled(); // if you fire on update
  });

  it('shows not paid when not funded', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      amountSats: 5000,
      paymentHash: 'hash789',
      testId: 'test-id',
    } as BountyInfo);

    // Mock LNbits → paid = false
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ paid: false }),
    } as any);

    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = {
      globalState: { get: jest.fn().mockReturnValue('http://test') },
      secrets: { get: jest.fn().mockResolvedValue('secret-key') },
    } as any;

    checkPaidCommand(bounties, mockEmitter, mockContext);

    expect(capturedHandler).toBeDefined();

    const mockTestItem = createMockTestItem({ id: 'test-id' });
    await capturedHandler!(mockTestItem);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/payments/hash789'),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'X-Api-Key': 'secret-key',
        }),
      })
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Bounty not yet paid.');

    // Bounty should NOT be marked paid
    expect(bounties.get('test-id')!.paid).toBeUndefined();
  });

  // No test selected
  it('should show error when no test item is provided', async () => {
    const bounties = new Map<string, BountyInfo>();
    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = {
      globalState: { get: jest.fn().mockReturnValue('http://test') },
      secrets: { get: jest.fn().mockResolvedValue('secret-key') },
    } as any;

    checkPaidCommand(bounties, mockEmitter, mockContext);

    expect(capturedHandler).toBeDefined();
    await capturedHandler!(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No test selected');
  });

  // No bounty or payment hash
  it('should show info message when bounty is missing or has no payment hash', async () => {
    const bounties = new Map<string, BountyInfo>();
    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = {
      globalState: { get: jest.fn().mockReturnValue('http://test') },
      secrets: { get: jest.fn().mockResolvedValue('secret-key') },
    } as any;

    // Scenario B: Bounty exists but no payment hash
    bounties.set('test-id', {
      amountSats: 5000,
      testId: 'test-id',
    } as BountyInfo); // No paymentHash

    checkPaidCommand(bounties, mockEmitter, mockContext);

    expect(capturedHandler).toBeDefined();
    const mockTestItem = createMockTestItem({ id: 'test-123' });
    await capturedHandler!(mockTestItem);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'No bounty or payment hash for this test'
    );
  });

  // LNbits config missing
  it('should show error when LNbits config is missing in globalState or secrets', async () => {
    const bounties = new Map<string, BountyInfo>();
    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = {
      globalState: { get: jest.fn().mockReturnValue(undefined) },
      secrets: { get: jest.fn().mockReturnValue(undefined) },
    } as any;

    bounties.set('test-123', { paymentHash: 'hash123' } as BountyInfo);
    checkPaidCommand(bounties, mockEmitter, mockContext);

    expect(capturedHandler).toBeDefined();
    const mockTestItem = createMockTestItem({ id: 'test-123' });
    await capturedHandler!(mockTestItem);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'LNbits config missing – run Add Bounty first'
    );
  });
});

describe('claimBountyCommand', () => {
  let capturedClaimHandler: ((test?: vscode.TestItem) => Promise<void>) | undefined;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock registerCommand and capture the real handler
    jest.spyOn(vscode.commands, 'registerCommand').mockImplementation((commandId, handler) => {
      if (commandId === 'bountyTestPlugin.claimBounty') {
        capturedClaimHandler = handler as any;
      }
      return { dispose: jest.fn() } as any;
    });

    // Optional: mock other things you need in every test
    (vscode.window.showInputBox as jest.Mock).mockReset();
    (vscode.window.showInformationMessage as jest.Mock).mockReset();
  });

  it('should show error when no test item is provided', async () => {
    const bounties = new Map<string, BountyInfo>();
    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = {
      globalState: { get: jest.fn().mockReturnValue('http://test') },
      secrets: { get: jest.fn().mockResolvedValue('secret-key') },
    } as any;

    claimBountyCommand(bounties, mockEmitter, mockContext);

    expect(capturedClaimHandler).toBeDefined();
    await capturedClaimHandler!(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No test selected');
  });

  it('should show info message when bounty is missing or has no payment hash', async () => {
    const bounties = new Map<string, BountyInfo>();
    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = {
      globalState: { get: jest.fn().mockReturnValue('http://test') },
      secrets: { get: jest.fn().mockResolvedValue('secret-key') },
    } as any;

    bounties.set('test-id', {
      amountSats: 5000,
      testId: 'test-id',
    } as BountyInfo); // No paymentHash

    claimBountyCommand(bounties, mockEmitter, mockContext);

    const mockTestItem = createMockTestItem({ id: 'test-id' });
    expect(capturedClaimHandler).toBeDefined();
    await capturedClaimHandler!(mockTestItem);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Bounty not funded yet or already claimed'
    );
  });

  it('sets pending status and triggers approval prompt', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      amountSats: 10000,
      invoice: 'lnbc...',
      paid: true,
      claimStatus: 'none' as ClaimStatus,
      testId: 'test-id',
    } as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;

    const mockContext = {
      globalState: {
        get: jest.fn().mockReturnValue('http://test'),
        update: jest.fn().mockResolvedValue(undefined),
      },
      secrets: {
        get: jest.fn().mockResolvedValue('secret-key'),
      },
    } as unknown as vscode.ExtensionContext;

    claimBountyCommand(bounties, mockEmitter, mockContext);

    expect(capturedClaimHandler).toBeDefined();

    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('lnbc_claim_invoice_123');

    (vscode.window.showInformationMessage as jest.Mock)
      .mockResolvedValueOnce(undefined) // claim sent (no button / no action)
      .mockResolvedValueOnce('Approve Payout'); // creator approves

    await capturedClaimHandler!(createMockTestItem({ id: 'test-id' }));

    const bounty = bounties.get('test-id')!;
    expect(bounty.claimStatus).toBe('pending');
    expect(bounty.claimedBy).toBe('lnbc_claim_invoice_123');

    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(2);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Claim request sent for 10000 sats. Waiting for creator approval.'),
      'OK' // ← matches what actually happens
    );

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Someone wants to claim your 10000 sats bounty on test'),
      'Approve Payout',
      'Reject'
    );

    // Removed / commented out – event is fired later (after approval + payout success)
    // expect(mockEmitter.fire).toHaveBeenCalled();
  });

  it('sets reject status and triggers reject prompt', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      amountSats: 10000,
      invoice: 'lnbc...',
      paid: true,
      claimStatus: 'none' as ClaimStatus,
      testId: 'test-id',
    } as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;

    const mockContext = {
      globalState: {
        get: jest.fn().mockReturnValue('http://test'),
        update: jest.fn().mockResolvedValue(undefined),
      },
      secrets: {
        get: jest.fn().mockResolvedValue('secret-key'),
      },
    } as unknown as vscode.ExtensionContext;

    claimBountyCommand(bounties, mockEmitter, mockContext);

    expect(capturedClaimHandler).toBeDefined();

    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('lnbc_claim_invoice_123');

    (vscode.window.showInformationMessage as jest.Mock)
      .mockResolvedValueOnce(undefined) // claim sent (no button / no action)
      .mockResolvedValueOnce('Reject'); // creator rejects

    await capturedClaimHandler!(createMockTestItem({ id: 'test-id' }));

    const bounty = bounties.get('test-id')!;
    expect(bounty.claimStatus).toBe('rejected');
    expect(bounty.claimedBy).toBe('lnbc_claim_invoice_123');

    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(2);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Claim request sent for 10000 sats. Waiting for creator approval.'),
      'OK' // ← matches what actually happens
    );

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Someone wants to claim your 10000 sats bounty on test'),
      'Approve Payout',
      'Reject'
    );
  });

  // what happens if user cancels input
  it('does nothing if user cancels invoice input', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      amountSats: 10000,
      paid: true,
      claimStatus: 'none' as ClaimStatus,
      testId: 'test-id',
    } as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = { globalState: { get: jest.fn() }, secrets: { get: jest.fn() } } as any;

    claimBountyCommand(bounties, mockEmitter, mockContext);

    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce(undefined); // user cancels

    await capturedClaimHandler!(createMockTestItem({ id: 'test-id' }));

    const bounty = bounties.get('test-id')!;
    expect(bounty.claimStatus).toBe('none'); // unchanged
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('Claim request sent')
    );
  });
});

describe('getWalletId', () => {
  it('returns wallet ID on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'wallet-abc123' }),
    } as any);

    const id = await getWalletId('http://test', 'key123');
    expect(id).toBe('wallet-abc123');
  });

  it('returns undefined on failure', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false } as any);
    const id = await getWalletId('http://test', 'key123');
    expect(id).toBeUndefined();
  });
});

describe('executePayout', () => {
  let capturedHandler: ((test?: vscode.TestItem) => Promise<void>) | undefined;
  const registerSpy = jest.spyOn(vscode.commands, 'registerCommand');

  beforeEach(() => {
    jest.clearAllMocks();
    capturedHandler = undefined;
    // Capture the handler for claimBountyCommand (since it calls executePayout)
    registerSpy.mockImplementation((commandId, handler) => {
      if (commandId === 'bountyTestPlugin.claimBounty') {
        capturedHandler = handler as (test?: vscode.TestItem) => Promise<void>;
      }
      return { dispose: jest.fn() } as any;
    });
  });
  afterEach(() => {
    registerSpy.mockRestore();
    mockFetch.mockReset();
    (vscode.window.showInformationMessage as jest.Mock).mockReset();
    (vscode.window.showErrorMessage as jest.Mock).mockReset();
  });
  it('sends payout and marks bounty as paid', async () => {
    const bounties = new Map<string, BountyInfo>();
    const bounty = {
      amountSats: 10000,
      creatorApiKey: 'creator-key',
      claimStatus: 'pending' as ClaimStatus,
      testId: 'test-id',
    } as BountyInfo;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ checking_id: 'payout-xyz' }),
    } as any);

    const mockContext = {
      globalState: { get: jest.fn().mockReturnValue('http://test-url') },
    } as any;

    const mockTestItem = createMockTestItem({ id: 'test-id' });

    await executePayout(bounties, bounty, 'lnbc_valid_claim_invoice', mockContext, mockTestItem);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/payments'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"out":true'),
      })
    );

    expect(bounty.paid).toBe(true);
    expect(bounty.claimStatus).toBe('approved');
    expect(bounties.get('test-id')).toBe(bounty); // same reference or deep equal
  });
});

// Helper to create consistent mock ExtensionContext
function createMockContext(
  overrides: Partial<vscode.ExtensionContext> = {}
): vscode.ExtensionContext {
  return {
    globalState: {
      get: jest.fn().mockReturnValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    },
    secrets: {
      get: jest.fn().mockResolvedValue(undefined),
      store: jest.fn().mockResolvedValue(undefined),
    },
    subscriptions: [],
    extensionPath: '',
    asAbsolutePath: jest.fn((path: string) => path),
    storagePath: '',
    globalStoragePath: '',
    logPath: '',
    ...overrides, // allows overriding globalState, secrets, etc.
  } as unknown as vscode.ExtensionContext;
}
