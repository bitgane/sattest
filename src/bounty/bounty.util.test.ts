import * as vscode from 'vscode';
import {
  addBountyCommand,
  removeBountyCommand,
  claimBountyCommand,
  approveClaimCommand,
} from './bounty.util.js';
import { BountyInfo, ClaimInfo, ClaimStatus } from './bounty.types.js';
import {
  createBounty as createBountyApi,
  claimBounty as claimBountyWithLnAddress,
  deactivateBounty,
  approveClaim as approveClaimApi,
  getPendingClaims as getPendingClaimsApi,
  readClaimPayoutAddress,
} from './bounty-store.js';
import { getNostrUserPubkey } from '../state.js';
import * as protocol from '../api/nostr-protocol.js';

jest.mock('qrcode', () => ({
  toString: jest.fn((text: string, options: any, cb: any) => cb(null, '<svg>fake-qr</svg>')),
}));

jest.mock('../api/nostr.api', () => ({
  connectNostr: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../state', () => ({
  getNostrUserPubkey: jest.fn().mockResolvedValue('creator-pubkey'),
  getNostrUserHandle: jest.fn().mockResolvedValue('@alice'),
  getNostrRelays: jest.fn().mockReturnValue([]),
  initializeSecrets: jest.fn(),
}));

jest.mock('../api/nwc.api', () => ({
  // Default: no wallet connected.
  getNwcStatus: jest.fn().mockResolvedValue({ configured: false }),
  setNwcUri: jest.fn(),
  clearNwcUri: jest.fn(),
}));

jest.mock('./bounty-store', () => ({
  createBounty: jest.fn(),
  claimBounty: jest.fn(),
  deactivateBounty: jest.fn(),
  approveClaim: jest.fn(),
  getPendingClaims: jest.fn(),
  resolveHeldClaim: jest.fn(),
  // Default: the creator's signer decrypts the claimant's payout address.
  readClaimPayoutAddress: jest.fn().mockResolvedValue('lnurl1abc'),
  announceBounty: jest.fn().mockResolvedValue(true),
  getLnurlLimits: jest.fn().mockResolvedValue(null),
}));

jest.mock('../git/repo-identity', () => ({
  getRepoIdentity: jest.fn().mockResolvedValue({ ok: true, repoId: 'r', rootSha: 'x' }),
  describeRepoIdentityFailure: jest.fn(() => 'needs a git repository'),
}));

jest.mock('../test/test-item.util', () => ({
  normalizedTestId: jest.fn().mockImplementation((test: any) => test.id),
  removeParentLabelFromTestId: jest.fn().mockImplementation((test: any) => test.id),
  getRepoSlug: jest.fn().mockResolvedValue('owner/repo'),
}));

// Trailer lookup shells out to real git against the workspace root, which
// doesn't exist under jest. Default to "the claimant's commit is in the
// creator's branch" so the existing approve tests exercise the happy path;
// the workflow-specific tests below override it. Real git behaviour is covered
// against actual repositories in src/git/claim-trailer.test.ts.
jest.mock('../git/claim-trailer', () => ({
  CLAIM_TRAILER_KEY: 'Sattest-Claim',
  verifyClaimTrailer: jest.fn(() => ({
    evidence: 'in-history',
    currentBranch: 'main',
    commits: [{ sha: 'abc12345', subject: 'fix the test', refs: ['main'], inHistory: true }],
  })),
  addClaimTrailerToHead: jest.fn(() => 'abc12345'),
  claimTrailerToken: jest.fn(() => 'deadbeefcafe0001'),
  readCommitPatches: jest.fn(() => 'diff --git a/x b/x\n+fixed'),
  headHasClaimTrailer: jest.fn(() => false),
  hasCommits: jest.fn(() => true),
  hasRemotes: jest.fn(() => true),
  fetchAllRemotes: jest.fn(() => true),
}));

// Announcement prompts depend on whether the Sattest account key is set in
// src/api/nostr-protocol.ts. Pin them off so these tests don't change meaning
// when a checkout configures the key; tests that need them switch them on.
let announcementsSpy: jest.SpyInstance;
beforeEach(() => {
  announcementsSpy = jest.spyOn(protocol, 'announcementsEnabled').mockReturnValue(false);
});
afterEach(() => {
  announcementsSpy.mockRestore();
});

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

    // Every bounty is NWC and requires a connected wallet. Default to "wallet
    // connected" for the happy-path tests; the no-wallet/auto-connect tests
    // override this.
    const { getNwcStatus } = require('../api/nwc.api');
    (getNwcStatus as jest.Mock).mockResolvedValue({ configured: true });
    // When a wallet is connected, addBounty asks "use it or pick a different
    // one". Default to keeping the existing wallet so happy-path tests proceed;
    // the dismiss / "different" tests override this per-call.
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ value: 'existing' });
    (vscode.commands.executeCommand as jest.Mock).mockClear?.();
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
      createdAt: new Date(),
      testId: mockTestItem.id,
    } as unknown as BountyInfo);

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

  it('handles createBounty API failure', async () => {
    const mockContext = createMockContext();
    const mockTestItem = createMockTestItem({ id: 'test-err' });

    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('1000');
    (createBountyApi as jest.Mock).mockRejectedValue(new Error('Relays offline'));

    addBountyCommand(bounties, mockEmitter as any, mockContext);
    await capturedHandler!(mockTestItem);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to create bounty')
    );
  });

  // ── NWC (non-custodial) is the only path ──────────────────────────────────
  it('wallet connected: prompts to use it (showing the wallet), then creates an NWC bounty', async () => {
    const mockContext = createMockContext();
    const mockTestItem = createMockTestItem({ id: 'test-nwc' });
    const { getNwcStatus } = require('../api/nwc.api');

    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('7777');
    (getNwcStatus as jest.Mock).mockResolvedValue({
      configured: true,
      relay: 'relay.getalby.com',
      lud16: 'alice@getalby.com',
    });
    // User keeps the existing wallet.
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({ value: 'existing' });

    (createBountyApi as jest.Mock).mockResolvedValue({
      id: 'bounty-uuid',
      testId: 'test-nwc',
      amountSats: 7777,
    });

    addBountyCommand(bounties, mockEmitter as any, mockContext);
    await capturedHandler!(mockTestItem);

    // The wallet-selection prompt showed the lightning address (label) + relay (description).
    const pickArgs = (vscode.window.showQuickPick as jest.Mock).mock.calls[0][0];
    expect(pickArgs[0].label).toContain('alice@getalby.com');
    expect(pickArgs[0].description).toBe('relay.getalby.com');

    expect(bounties.size).toBe(1);
    const args = (createBountyApi as jest.Mock).mock.calls[0];
    // Existing wallet kept → the connect command is NOT launched.
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('sattest.connectWallet');
    // No QR webview opened — that helper would call createWebviewPanel.
    expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('connected wallet')
    );
  });

  it('wallet connected: falls back to the relay host as the label when lud16 is absent', async () => {
    const mockContext = createMockContext();
    const { getNwcStatus } = require('../api/nwc.api');

    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('1000');
    (getNwcStatus as jest.Mock).mockResolvedValue({
      configured: true,
      relay: 'relay.example.com',
      lud16: null,
    });
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({ value: 'existing' });
    (createBountyApi as jest.Mock).mockResolvedValue({ id: 'b', fundingMode: 'nwc' });

    addBountyCommand(bounties, mockEmitter as any, mockContext);
    await capturedHandler!(createMockTestItem({ id: 'test-relaylabel' }));

    const pickArgs = (vscode.window.showQuickPick as jest.Mock).mock.calls[0][0];
    expect(pickArgs[0].label).toContain('relay.example.com');
  });

  it('wallet connected: picking "Connect a different wallet" relaunches the connect flow', async () => {
    const mockContext = createMockContext();
    const { getNwcStatus } = require('../api/nwc.api');

    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('2000');
    // configured both before and after reconnect.
    (getNwcStatus as jest.Mock).mockResolvedValue({
      configured: true,
      relay: 'relay.getalby.com',
      lud16: 'alice@getalby.com',
    });
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({ value: 'different' });
    (createBountyApi as jest.Mock).mockResolvedValue({ id: 'b', fundingMode: 'nwc' });

    addBountyCommand(bounties, mockEmitter as any, mockContext);
    await capturedHandler!(createMockTestItem({ id: 'test-diff' }));

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('sattest.connectWallet');
    expect(bounties.size).toBe(1);
    const args = (createBountyApi as jest.Mock).mock.calls[0];
  });

  it('wallet connected: dismissing the wallet prompt cancels creation', async () => {
    const mockContext = createMockContext();
    const { getNwcStatus } = require('../api/nwc.api');

    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('2000');
    (getNwcStatus as jest.Mock).mockResolvedValue({ configured: true, relay: 'r', lud16: 'a@b' });
    // User hits Esc on the use-existing/different pick.
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce(undefined);

    addBountyCommand(bounties, mockEmitter as any, mockContext);
    await capturedHandler!(createMockTestItem({ id: 'test-dismiss' }));

    expect(createBountyApi).not.toHaveBeenCalled();
    expect(bounties.size).toBe(0);
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('sattest.connectWallet');
  });

  it('wallet connected: offers a "remember for this session" option in the prompt', async () => {
    const mockContext = createMockContext();
    const { getNwcStatus } = require('../api/nwc.api');

    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('1000');
    (getNwcStatus as jest.Mock).mockResolvedValue({ configured: true, relay: 'r', lud16: 'a@b' });
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({ value: 'remember' });
    (createBountyApi as jest.Mock).mockResolvedValue({ id: 'b', fundingMode: 'nwc' });

    addBountyCommand(bounties, mockEmitter as any, mockContext);
    await capturedHandler!(createMockTestItem({ id: 'test-remember-opt' }));

    const items = (vscode.window.showQuickPick as jest.Mock).mock.calls[0][0];
    expect(items.some((i: any) => i.value === 'remember')).toBe(true);
    expect(bounties.size).toBe(1);
  });

  it('remember choice: after picking "don\'t ask again", later creations skip the prompt', async () => {
    const mockContext = createMockContext();
    const { getNwcStatus } = require('../api/nwc.api');

    (vscode.window.showInputBox as jest.Mock).mockResolvedValue('1000'); // both creations
    (getNwcStatus as jest.Mock).mockResolvedValue({ configured: true, relay: 'r', lud16: 'a@b' });
    (createBountyApi as jest.Mock).mockResolvedValue({ id: 'b', fundingMode: 'nwc' });

    // Register ONCE — the session flag lives in this registration's closure.
    addBountyCommand(bounties, mockEmitter as any, mockContext);

    // First creation: user opts to remember.
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({ value: 'remember' });
    await capturedHandler!(createMockTestItem({ id: 'remember-1' }));
    expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
    expect(bounties.size).toBe(1);

    // Second creation: no prompt — the remembered wallet is used silently.
    (vscode.window.showQuickPick as jest.Mock).mockClear();
    await capturedHandler!(createMockTestItem({ id: 'remember-2' }));
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(bounties.size).toBe(2);
    expect(createBountyApi).toHaveBeenCalledTimes(2);
  });

  it('announcements configured: asks who can see the bounty, and keeps it private by choice', async () => {
    announcementsSpy.mockReturnValue(true);
    const { announceBounty } = require('./bounty-store');
    (announceBounty as jest.Mock).mockClear();
    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('2100');
    (vscode.window.showQuickPick as jest.Mock)
      .mockReset()
      .mockResolvedValueOnce({ value: 'existing' }) // wallet picker
      .mockResolvedValueOnce({ announce: false }); // visibility picker
    (createBountyApi as jest.Mock).mockResolvedValue({ id: 'b', testId: 'vis-1', amountSats: 2100 });

    addBountyCommand(bounties, mockEmitter as any, createMockContext());
    await capturedHandler!(createMockTestItem({ id: 'vis-1' }));

    const [, visibilityOpts] = (vscode.window.showQuickPick as jest.Mock).mock.calls[1];
    expect(visibilityOpts.title).toBe('Who can see this bounty?');
    expect(bounties.size).toBe(1);
    expect(announceBounty).not.toHaveBeenCalled();
  });

  it('no wallet: auto-launches the connect flow, then creates the NWC bounty', async () => {
    const mockContext = createMockContext();
    const mockTestItem = createMockTestItem({ id: 'test-autoconnect' });
    const { getNwcStatus } = require('../api/nwc.api');

    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('3000');
    // Not connected on the first check; connected after the connect command runs.
    (getNwcStatus as jest.Mock)
      .mockResolvedValueOnce({ configured: false })
      .mockResolvedValueOnce({ configured: true });

    (createBountyApi as jest.Mock).mockResolvedValue({
      id: 'bounty-uuid',
      testId: 'test-autoconnect',
      amountSats: 3000,
    });

    addBountyCommand(bounties, mockEmitter as any, mockContext);
    await capturedHandler!(mockTestItem);

    // The connect-wallet command was launched automatically.
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('sattest.connectWallet');
    // …and once connected, the bounty was created as NWC.
    expect(bounties.size).toBe(1);
    const args = (createBountyApi as jest.Mock).mock.calls[0];
  });

  it('no wallet and user skips connect: warns and creates nothing', async () => {
    const mockContext = createMockContext();
    const mockTestItem = createMockTestItem({ id: 'test-noconnect' });
    const { getNwcStatus } = require('../api/nwc.api');

    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('3000');
    // Still not connected even after the connect command runs.
    (getNwcStatus as jest.Mock)
      .mockResolvedValueOnce({ configured: false })
      .mockResolvedValueOnce({ configured: false });

    addBountyCommand(bounties, mockEmitter as any, mockContext);
    await capturedHandler!(mockTestItem);

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('sattest.connectWallet');
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('connected Lightning wallet is required')
    );
    expect(createBountyApi).not.toHaveBeenCalled();
    expect(bounties.size).toBe(0);
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
      testId: 'test-id',
      creatorId: 'creator-pubkey',
      claims: [] as ClaimInfo[],
    } as unknown as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = createMockContext();

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, Remove');
    (deactivateBounty as jest.Mock).mockResolvedValue(true);

    removeBountyCommand(bounties, mockEmitter, mockContext);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(bounties.size).toBe(0);
    expect(mockEmitter.fire).toHaveBeenCalled();
    // Unpaid bounty → no LNURL prompt, API called with a single arg
    expect(deactivateBounty).toHaveBeenCalledWith(expect.objectContaining({ id: 'bounty-uuid' }));
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
    } as unknown as BountyInfo);

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
    } as unknown as BountyInfo);

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
    } as unknown as BountyInfo);

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
    } as unknown as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = createMockContext();

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, Remove');
    (deactivateBounty as jest.Mock).mockResolvedValue(false);

    removeBountyCommand(bounties, mockEmitter, mockContext);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(bounties.size).toBe(1);
  });

  // ── Refund flow ──────────────────────────────────────────────────────────
  function paidBounty(overrides: Partial<BountyInfo> = {}): BountyInfo {
    return {
      id: 'bounty-uuid',
      amountSats: 1000,
      testId: 'test-id',
      creatorId: 'creator-pubkey',
      claims: [] as ClaimInfo[],
      ...overrides,
    } as unknown as BountyInfo;
  }

  it('paid bounty with pending claim: the confirm names the waiting claimant; declining aborts', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', paidBounty({ claims: [{ status: 'pending' } as ClaimInfo] }));
    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = createMockContext();

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce(undefined);

    removeBountyCommand(bounties, mockEmitter, mockContext);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    const [, options, button] = (vscode.window.showWarningMessage as jest.Mock).mock.calls[0];
    expect(options.detail).toMatch(/waiting for your review/);
    expect(button).toBe('Remove and Cancel Claim');
    expect(deactivateBounty).not.toHaveBeenCalled();
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    expect(bounties.size).toBe(1);
  });

  it('approved bounty: the confirm dialog flags it as already paid', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', paidBounty({ claims: [{ status: 'approved' } as ClaimInfo] }));
    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = createMockContext();

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Yes, Remove');
    (deactivateBounty as jest.Mock).mockResolvedValue(true);

    removeBountyCommand(bounties, mockEmitter, mockContext);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    const [message, options] = (vscode.window.showWarningMessage as jest.Mock).mock.calls[0];
    expect(message).toMatch(/paid/i);
    expect(options.detail).toMatch(/already paid out/i);
  });

  it('unpaid bounty: the confirm dialog has no "paid" detail', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      id: 'bounty-uuid',
      amountSats: 1000,
      testId: 'test-id',
      creatorId: 'creator-pubkey',
      claims: [] as ClaimInfo[],
    } as unknown as BountyInfo);
    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = createMockContext();

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Yes, Remove');
    (deactivateBounty as jest.Mock).mockResolvedValue(true);

    removeBountyCommand(bounties, mockEmitter, mockContext);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    const [message, options] = (vscode.window.showWarningMessage as jest.Mock).mock.calls[0];
    expect(message).not.toMatch(/paid/i);
    expect(options.detail).toBeUndefined();
  });

  it('NWC bounty with pending claim: warns that removing cancels the claim', async () => {
    // Without the pending-claim warning, this removal would drop the claimant
    // behind a generic "Remove N sats bounty?" confirm.
    const bounties = new Map<string, BountyInfo>();
    bounties.set(
      'test-id',
      paidBounty({ claims: [{ status: 'pending' } as ClaimInfo] })
    );
    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = createMockContext();

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce(
      'Remove and Cancel Claim'
    );
    (deactivateBounty as jest.Mock).mockResolvedValue(true);

    removeBountyCommand(bounties, mockEmitter, mockContext);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    const [message, options, button] = (vscode.window.showWarningMessage as jest.Mock).mock
      .calls[0];
    expect(message).not.toMatch(/paid/i);
    expect(options).toEqual(expect.objectContaining({ modal: true }));
    expect(options.detail).toMatch(/waiting for your review/);
    expect(options.detail).toMatch(/cancels their claim/);
    expect(button).toBe('Remove and Cancel Claim');
    // Nothing was ever custodied, so there's no refund to ask about.
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    expect(deactivateBounty).toHaveBeenCalledWith(expect.objectContaining({ id: 'bounty-uuid' }));
    expect(bounties.size).toBe(0);
  });

  it('NWC bounty with pending claim: dismissing the warning keeps the bounty', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set(
      'test-id',
      paidBounty({ claims: [{ status: 'pending' } as ClaimInfo] })
    );
    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = createMockContext();

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce(undefined);

    removeBountyCommand(bounties, mockEmitter, mockContext);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(deactivateBounty).not.toHaveBeenCalled();
    expect(mockEmitter.fire).not.toHaveBeenCalled();
    expect(bounties.size).toBe(1);
  });

  it('bounty with a payout in flight: refuses to remove it', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set(
      'test-id',
      paidBounty({ claims: [{ status: 'approving' } as ClaimInfo] })
    );
    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = createMockContext();

    removeBountyCommand(bounties, mockEmitter, mockContext);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    // Explains instead of confirming: no modal, no refund prompt, no API call.
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    const [message, options] = (vscode.window.showWarningMessage as jest.Mock).mock.calls[0];
    expect(message).toMatch(/still being confirmed/);
    expect(message).toContain('"Payout Processing" lens');
    expect(options).toBeUndefined();
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    expect(deactivateBounty).not.toHaveBeenCalled();
    expect(bounties.size).toBe(1);
  });

  it('counts a bounty as paid even when a newer pending claim is listed first', async () => {
    // Listings are newest-first, so a claim filed after the payout sits at
    // claims[0]. Reading only that one would treat the bounty as unpaid.
    const bounties = new Map<string, BountyInfo>();
    bounties.set(
      'test-id',
      paidBounty({
        claims: [{ status: 'pending' } as ClaimInfo, { status: 'approved' } as ClaimInfo],
      })
    );
    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = createMockContext();

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Yes, Remove');
    (deactivateBounty as jest.Mock).mockResolvedValue(true);

    removeBountyCommand(bounties, mockEmitter, mockContext);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    const [message, options] = (vscode.window.showWarningMessage as jest.Mock).mock.calls[0];
    expect(message).toMatch(/paid/i);
    expect(options.detail).toMatch(/already paid out/i);
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    expect(deactivateBounty).toHaveBeenCalledWith(expect.objectContaining({ id: 'bounty-uuid' }));
  });

  it('refuses removal when a payout is in flight behind a newer pending claim', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set(
      'test-id',
      paidBounty({
        claims: [{ status: 'pending' } as ClaimInfo, { status: 'approving' } as ClaimInfo],
      })
    );
    const mockEmitter = { fire: jest.fn() } as any;
    const mockContext = createMockContext();

    removeBountyCommand(bounties, mockEmitter, mockContext);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('still being confirmed')
    );
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    expect(deactivateBounty).not.toHaveBeenCalled();
    expect(bounties.size).toBe(1);
  });
});

describe('claimBountyCommand', () => {
  let capturedHandler: ((test?: vscode.TestItem) => Promise<void>) | undefined;

  const openBounty = (overrides: Partial<BountyInfo> = {}) =>
    ({
      id: 'bounty-uuid',
      coordinate: '37400:creator:bounty-uuid',
      amountSats: 10000,
      status: 'open',
      active: true,
      claims: [] as ClaimInfo[],
      testId: 'test-id',
      ...overrides,
    }) as unknown as BountyInfo;

  beforeEach(() => {
    jest.spyOn(vscode.commands, 'registerCommand').mockImplementation((id, handler) => {
      if (id === 'sattest.claimBounty') {
        capturedHandler = handler as any;
      }
      return { dispose: jest.fn() } as any;
    });
    (getNostrUserPubkey as jest.Mock).mockResolvedValue('claimant-pubkey');
    (claimBountyWithLnAddress as jest.Mock).mockReset();
  });

  it('shows error when no test item is provided', async () => {
    claimBountyCommand(new Map(), { fire: jest.fn() } as any);
    await capturedHandler!(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No test selected');
  });

  it('refuses a bounty that is not open', async () => {
    const bounties = new Map<string, BountyInfo>([['test-id', openBounty({ status: 'paid' })]]);

    claimBountyCommand(bounties, { fire: jest.fn() } as any);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'This bounty is not open for claims'
    );
    expect(claimBountyWithLnAddress).not.toHaveBeenCalled();
  });

  it('requires a Nostr identity to sign the claim', async () => {
    (getNostrUserPubkey as jest.Mock).mockResolvedValue(undefined);
    const bounties = new Map<string, BountyInfo>([['test-id', openBounty()]]);

    claimBountyCommand(bounties, { fire: jest.fn() } as any);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Connect Nostr first')
    );
  });

  it('does nothing if user cancels lnurl input', async () => {
    const bounties = new Map<string, BountyInfo>([['test-id', openBounty()]]);
    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce(undefined);

    claimBountyCommand(bounties, { fire: jest.fn() } as any);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(claimBountyWithLnAddress).not.toHaveBeenCalled();
  });

  it('submits a claim after the verification choice, with no other picker', async () => {
    const bounties = new Map<string, BountyInfo>([['test-id', openBounty()]]);
    const mockEmitter = { fire: jest.fn() } as any;

    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('alice@primal.net');
    (vscode.window.showQuickPick as jest.Mock).mockReset().mockResolvedValueOnce({ tag: true });
    (claimBountyWithLnAddress as jest.Mock).mockResolvedValue({
      id: 'claim-1',
      claimantPubkey: 'claimant-pubkey',
      status: 'pending',
    });

    claimBountyCommand(bounties, mockEmitter);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(claimBountyWithLnAddress).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'bounty-uuid' }),
      'alice@primal.net',
      { claimantPubkey: 'claimant-pubkey', publicConsent: false }
    );
    expect(bounties.get('test-id')!.claims[0].status).toBe('pending');
    expect(mockEmitter.fire).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Claim request sent')
    );
    // Only the verification picker: announcements aren't configured.
    expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
    // The privacy note lives in the address prompt instead.
    const prompt = (vscode.window.showInputBox as jest.Mock).mock.calls.at(-1)![0].prompt;
    expect(prompt).toMatch(/encrypted so only the bounty creator can read it/);
  });

  describe('with public announcements configured', () => {
    beforeEach(() => {
      announcementsSpy.mockReturnValue(true);
    });

    it('offers private or public and passes the consent through', async () => {
      const bounties = new Map<string, BountyInfo>([['test-id', openBounty()]]);
      (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('alice@primal.net');
      (vscode.window.showQuickPick as jest.Mock)
        .mockReset()
        .mockResolvedValueOnce({ tag: false }) // verification picker comes first
        .mockImplementationOnce(async (items: any[]) => {
          expect(items).toHaveLength(2);
          return items.find((i) => i.publicConsent);
        });
      (claimBountyWithLnAddress as jest.Mock).mockResolvedValue({
        id: 'claim-1',
        claimantPubkey: 'claimant-pubkey',
        status: 'pending',
      });

      claimBountyCommand(bounties, { fire: jest.fn() } as any);
      await capturedHandler!(createMockTestItem({ id: 'test-id' }));

      expect(claimBountyWithLnAddress).toHaveBeenCalledWith(
        expect.anything(),
        'alice@primal.net',
        { claimantPubkey: 'claimant-pubkey', publicConsent: true }
      );
    });

    it('cancels the claim (nothing sent) when the announcement picker is dismissed', async () => {
      const bounties = new Map<string, BountyInfo>([['test-id', openBounty()]]);
      (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('alice@primal.net');
      (vscode.window.showQuickPick as jest.Mock)
        .mockReset()
        .mockResolvedValueOnce({ tag: true })
        .mockResolvedValueOnce(undefined);

      claimBountyCommand(bounties, { fire: jest.fn() } as any);
      await capturedHandler!(createMockTestItem({ id: 'test-id' }));

      expect(claimBountyWithLnAddress).not.toHaveBeenCalled();
    });
  });

  it('asks before replacing an existing claim from the same claimant', async () => {
    const bounties = new Map<string, BountyInfo>([
      [
        'test-id',
        openBounty({ claims: [{ claimantPubkey: 'claimant-pubkey', status: 'pending' } as ClaimInfo] }),
      ],
    ]);
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValueOnce(undefined);

    claimBountyCommand(bounties, { fire: jest.fn() } as any);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('already claimed'),
      'Replace payout address'
    );
    expect(claimBountyWithLnAddress).not.toHaveBeenCalled();
  });

  describe('commit tagging choice', () => {
    const run = async (choice: { tag: boolean } | undefined) => {
      const bounties = new Map<string, BountyInfo>([['test-id', openBounty()]]);
      const { addClaimTrailerToHead, headHasClaimTrailer } = require('../git/claim-trailer');
      (addClaimTrailerToHead as jest.Mock).mockClear();
      (headHasClaimTrailer as jest.Mock).mockReturnValue(false);
      (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('alice@primal.net');
      (vscode.window.showQuickPick as jest.Mock).mockReset().mockResolvedValueOnce(choice);
      (vscode.window.showInformationMessage as jest.Mock).mockClear();
      (claimBountyWithLnAddress as jest.Mock).mockResolvedValue({
        id: 'claim-1',
        claimantPubkey: 'claimant-pubkey',
        status: 'pending',
      });
      claimBountyCommand(bounties, { fire: jest.fn() } as any);
      await capturedHandler!(createMockTestItem({ id: 'test-id' }));
      return { addClaimTrailerToHead };
    };

    it('offers tagging first, with guidance on when to pick each option', async () => {
      await run(undefined);
      const [items, opts] = (vscode.window.showQuickPick as jest.Mock).mock.calls[0];
      expect(opts.title).toBe('How will the bounty creator know this work is yours?');
      expect(items.map((i: any) => i.tag)).toEqual([true, false]);
      expect(items[0].label).toMatch(/Tag my latest commit \(recommended\)/);
      expect(items[0].detail).toMatch(/public or busy repositories/);
      expect(items[1].detail).toMatch(/small team/);
    });

    it('tagging amends the latest commit right after claiming, with no second prompt', async () => {
      const { addClaimTrailerToHead } = await run({ tag: true });
      expect(claimBountyWithLnAddress).toHaveBeenCalled();
      expect(addClaimTrailerToHead).toHaveBeenCalledWith('bounty-uuid', 'claimant-pubkey');
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'Tag latest commit',
        expect.anything()
      );
    });

    it('skipping leaves git alone and says how to tag later', async () => {
      const { addClaimTrailerToHead } = await run({ tag: false });
      expect(claimBountyWithLnAddress).toHaveBeenCalled();
      expect(addClaimTrailerToHead).not.toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('Add Claim Trailer to Latest Commit')
      );
    });

    it('dismissing the choice cancels the claim', async () => {
      await run(undefined);
      expect(claimBountyWithLnAddress).not.toHaveBeenCalled();
    });
  });

  it('handles claim errors', async () => {
    const bounties = new Map<string, BountyInfo>([['test-id', openBounty()]]);
    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('alice@primal.net');
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({ tag: false });
    (claimBountyWithLnAddress as jest.Mock).mockRejectedValue(new Error('No relay accepted'));

    claimBountyCommand(bounties, { fire: jest.fn() } as any);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to claim bounty')
    );
  });
});

describe('approveClaimCommand', () => {
  let capturedHandler: ((test?: vscode.TestItem) => Promise<void>) | undefined;

  const MOCK_CLAIM_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const MOCK_CLAIMANT_PUBKEY = 'd'.repeat(64);
  const MOCK_OTHER_CLAIM_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const MOCK_ATTACKER_PUBKEY = 'e'.repeat(64);

  beforeEach(() => {
    jest.spyOn(vscode.commands, 'registerCommand').mockImplementation((id, handler) => {
      if (id === 'sattest.approveClaim') {
        capturedHandler = handler as any;
      }
      return { dispose: jest.fn() } as any;
    });
    // Trailer verification defaults back to "merged" for every test. Mock
    // *implementations* survive jest.clearAllMocks(), so a test that stubs an
    // unverified claim would otherwise leave every later test unverified — and
    // an unverified claim now blocks on a modal.
    const { verifyClaimTrailer } = require('../git/claim-trailer');
    (verifyClaimTrailer as jest.Mock).mockReturnValue({
      evidence: 'in-history',
      currentBranch: 'main',
      commits: [{ sha: 'abc12345', subject: 'fix the test', refs: ['main'], inHistory: true }],
    });
    // Default pending claim — gives the handler something to show in the confirm dialog
    (getPendingClaimsApi as jest.Mock).mockResolvedValue([
      {
        id: MOCK_CLAIM_ID,
        claimantLnurl: 'lightning@example.com',
        claimantPubkey: MOCK_CLAIMANT_PUBKEY,
        claimedAt: new Date().toISOString(),
        status: 'pending',
      },
    ]);
    // NWC bounties precheck the wallet before approving. Default to "connected"
    // so the happy-path tests proceed; the wallet-not-connected tests override.
    const { getNwcStatus } = require('../api/nwc.api');
    (getNwcStatus as jest.Mock).mockResolvedValue({ configured: true });
    (vscode.commands.executeCommand as jest.Mock).mockClear?.();
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
    } as unknown as BountyInfo);

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

    expect(approveClaimApi).toHaveBeenCalledWith(expect.objectContaining({ id: 'bounty-uuid' }), expect.objectContaining({ id: MOCK_CLAIM_ID, claimantPubkey: MOCK_CLAIMANT_PUBKEY }));
  });

  it('blocks non-creator from approving', async () => {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      id: 'bounty-uuid',
      amountSats: 10000,
      testId: 'test-id',
      creatorId: 'other-pubkey',
      claims: [{ status: 'pending' as ClaimStatus }],
    } as unknown as BountyInfo);

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
    } as unknown as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;

    // The modal only offers 'Yes, Approve Payout' — VS Code's native Cancel
    // (or Esc) resolves to undefined.
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

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
    } as unknown as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, Approve Payout');
    (approveClaimApi as jest.Mock).mockResolvedValue({
      id: 'bounty-uuid',
      claims: [{ status: 'approved' }],
    });

    approveClaimCommand(bounties, mockEmitter);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(approveClaimApi).toHaveBeenCalledWith(expect.objectContaining({ id: 'bounty-uuid' }), expect.objectContaining({ id: MOCK_CLAIM_ID, claimantPubkey: MOCK_CLAIMANT_PUBKEY }));
    expect(bounties.get('test-id')!.claims[0].status).toBe('approved');
    expect(mockEmitter.fire).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Claim approved – payout sent from your wallet!'
    );
  });

  it('approves a single untagged claim without asking to fetch commits', async () => {
    (getNostrUserPubkey as jest.Mock).mockResolvedValue('creator-pubkey');
    const { verifyClaimTrailer } = require('../git/claim-trailer');
    (verifyClaimTrailer as jest.Mock).mockReturnValue({ evidence: 'absent', commits: [] });
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      id: 'bounty-uuid',
      amountSats: 10000,
      testId: 'test-id',
      creatorId: 'creator-pubkey',
      claims: [{ status: 'pending' as ClaimStatus }],
    } as unknown as BountyInfo);
    (vscode.window.showInformationMessage as jest.Mock).mockClear();
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, Approve Payout');
    (approveClaimApi as jest.Mock).mockResolvedValue({ id: 'bounty-uuid', claims: [] });

    approveClaimCommand(bounties, { fire: jest.fn() } as any);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    // Tagging is optional: one claim needs no telling apart from others.
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('No commit in this repo'),
      expect.anything(),
      expect.anything()
    );
    expect(approveClaimApi).toHaveBeenCalled();
  });

  // ── Claim hijack: several people can claim the same bounty ──────────────
  //
  // Claims are open by design, and the creator identifies their contributor
  // out-of-band. Auto-selecting a claim for them is what let an attacker file
  // a late claim and receive the payout — so when there's more than one, the
  // creator names the recipient.
  describe('multiple open claims', () => {
    const twoClaims = () => [
      {
        id: MOCK_OTHER_CLAIM_ID,
        claimantLnurl: null,
        claimantPubkey: MOCK_ATTACKER_PUBKEY,
        claimedAt: new Date().toISOString(),
        status: 'pending',
        lnurlHidden: true,
      },
      {
        id: MOCK_CLAIM_ID,
        claimantLnurl: 'lightning@example.com',
        claimantPubkey: MOCK_CLAIMANT_PUBKEY,
        claimedAt: new Date().toISOString(),
        status: 'pending',
        lnurlHidden: false,
      },
    ];

    const bountyWithPendingClaim = () => {
      const bounties = new Map<string, BountyInfo>();
      bounties.set('test-id', {
        id: 'bounty-uuid',
        amountSats: 10000,
        testId: 'test-id',
        creatorId: 'creator-pubkey',
        claims: [{ status: 'pending' as ClaimStatus }],
      } as unknown as BountyInfo);
      return bounties;
    };

    beforeEach(() => {
      (getNostrUserPubkey as jest.Mock).mockResolvedValue('creator-pubkey');
      (getPendingClaimsApi as jest.Mock).mockResolvedValue(twoClaims());
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, Approve Payout');
      (approveClaimApi as jest.Mock).mockResolvedValue({
        id: 'bounty-uuid',
        claims: [{ status: 'approved' }],
      });
    });

    it('makes the creator choose the recipient instead of picking the newest', async () => {
      // The newest claim is the attacker's; picking it silently is the bug.
      (vscode.window.showQuickPick as jest.Mock).mockImplementation(async (items: any[]) => {
        return items.find((i) => i.claim.id === MOCK_CLAIM_ID);
      });

      approveClaimCommand(bountyWithPendingClaim(), { fire: jest.fn() } as any);
      await capturedHandler!(createMockTestItem({ id: 'test-id' }));

      expect(vscode.window.showQuickPick).toHaveBeenCalled();
      expect(approveClaimApi).toHaveBeenCalledWith(expect.objectContaining({ id: 'bounty-uuid' }), expect.objectContaining({ id: MOCK_CLAIM_ID, claimantPubkey: MOCK_CLAIMANT_PUBKEY }));
    });

    it('offers every claimant by pubkey, without decrypting every payout address', async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

      approveClaimCommand(bountyWithPendingClaim(), { fire: jest.fn() } as any);
      await capturedHandler!(createMockTestItem({ id: 'test-id' }));

      const items = (vscode.window.showQuickPick as jest.Mock).mock.calls[0][0];
      expect(items).toHaveLength(2);
      // The hidden-address claim is still attributable to its claimant.
      const hidden = items.find((i: any) => i.claim.id === MOCK_OTHER_CLAIM_ID);
      expect(hidden.label).toContain(MOCK_ATTACKER_PUBKEY.slice(0, 16));
      // Addresses are encrypted to the creator; only the chosen one is
      // decrypted (one signer request), so the picker never shows them.
      expect(hidden.detail).toMatch(/payout address shown on the next step/);
      expect(readClaimPayoutAddress).not.toHaveBeenCalled();
    });

    it('approves nothing when the creator dismisses the chooser', async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

      approveClaimCommand(bountyWithPendingClaim(), { fire: jest.fn() } as any);
      await capturedHandler!(createMockTestItem({ id: 'test-id' }));

      expect(approveClaimApi).not.toHaveBeenCalled();
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('ranks the claim with commits in the creator\'s branch above the unbacked one', async () => {
      // The attacker's claim is newest, so the old code paid it. Now the claim
      // whose commits the creator can actually see sorts first — a default
      // highlight, not a gate.
      const { verifyClaimTrailer } = require('../git/claim-trailer');
      // Trailers are derived per bounty, so lookup takes (bountyId, pubkey).
      (verifyClaimTrailer as jest.Mock).mockImplementation((_bountyId: string, pubkey: string) =>
        pubkey === MOCK_CLAIMANT_PUBKEY
          ? {
              evidence: 'in-history',
              currentBranch: 'feature/checkout',
              commits: [
                { sha: 'abc12345', subject: 'fix refund path', refs: ['feature/checkout'], inHistory: true },
              ],
            }
          : { evidence: 'absent', commits: [] }
      );
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

      approveClaimCommand(bountyWithPendingClaim(), { fire: jest.fn() } as any);
      await capturedHandler!(createMockTestItem({ id: 'test-id' }));

      const items = (vscode.window.showQuickPick as jest.Mock).mock.calls[0][0];
      expect(items[0].claim.id).toBe(MOCK_CLAIM_ID);
      // Location, phrased as a fact — no PR vocabulary, no grade.
      expect(items[0].description).toContain('in your current branch (feature/checkout)');
      expect(items[0].detail).toContain('fix refund path');
      expect(items[1].description).toContain('no tagged commit');
    });

    it('never blocks approval on where the commits happen to live', async () => {
      // A team sharing a branch, or a maintainer approving a PR before merging,
      // must not be nagged. Evidence is shown; the decision stays the creator's.
      const { verifyClaimTrailer } = require('../git/claim-trailer');
      (verifyClaimTrailer as jest.Mock).mockReturnValue({
        evidence: 'elsewhere',
        currentBranch: 'main',
        commits: [
          { sha: 'def67890', subject: 'fix refund path', refs: ['origin/pr-99'], inHistory: false },
        ],
      });
      (vscode.window.showQuickPick as jest.Mock).mockImplementation(
        async (items: any[]) => items[0]
      );

      approveClaimCommand(bountyWithPendingClaim(), { fire: jest.fn() } as any);
      await capturedHandler!(createMockTestItem({ id: 'test-id' }));

      // Straight to the single confirm dialog — no extra warning modal in between.
      expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
      const [, opts] = (vscode.window.showWarningMessage as jest.Mock).mock.calls[0];
      expect(opts.detail).toContain('origin/pr-99');
      expect(opts.detail).toContain('fix refund path');
      expect(approveClaimApi).toHaveBeenCalled();
    });

    it('offers to fetch when no claim has commits on this machine yet', async () => {
      // The normal state when reviewing a PR you haven't fetched. Go get the
      // commits rather than telling the creator their process is wrong.
      const { verifyClaimTrailer, fetchAllRemotes } = require('../git/claim-trailer');
      (verifyClaimTrailer as jest.Mock).mockReturnValue({ evidence: 'absent', commits: [] });
      (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Fetch and re-check');
      (vscode.window.showQuickPick as jest.Mock).mockImplementation(
        async (items: any[]) => items[0]
      );

      approveClaimCommand(bountyWithPendingClaim(), { fire: jest.fn() } as any);
      await capturedHandler!(createMockTestItem({ id: 'test-id' }));

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('Fetch from your remotes'),
        'Fetch and re-check',
        'Continue anyway'
      );
      expect(fetchAllRemotes).toHaveBeenCalled();
      // And the approval still proceeds — fetching is help, not a gate.
      expect(approveClaimApi).toHaveBeenCalled();
    });

    it('reviewing the changes keeps the claim the creator picked', async () => {
      (vscode.window.showQuickPick as jest.Mock).mockImplementation(async (items: any[]) =>
        items.find((i) => i.claim.id === MOCK_CLAIM_ID)
      );
      (vscode.window.showWarningMessage as jest.Mock)
        .mockResolvedValueOnce('Review changes')
        .mockResolvedValueOnce('Yes, Approve Payout');
      (vscode.window.showInformationMessage as jest.Mock).mockResolvedValueOnce('Approve & Pay…');

      approveClaimCommand(bountyWithPendingClaim(), { fire: jest.fn() } as any);
      await capturedHandler!(createMockTestItem({ id: 'test-id' }));

      // Not asked to pick again, and the payout stays bound to that pick.
      expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
      expect(approveClaimApi).toHaveBeenCalledWith(expect.objectContaining({ id: 'bounty-uuid' }), expect.objectContaining({ id: MOCK_CLAIM_ID, claimantPubkey: MOCK_CLAIMANT_PUBKEY }));
    });

    it('does not pay when the store reports the claimant changed', async () => {
      (vscode.window.showQuickPick as jest.Mock).mockImplementation(async (items: any[]) => items[1]);
      (approveClaimApi as jest.Mock).mockResolvedValue('claimant-changed');
      const bounties = bountyWithPendingClaim();

      approveClaimCommand(bounties, { fire: jest.fn() } as any);
      await capturedHandler!(createMockTestItem({ id: 'test-id' }));

      // Never reported as a success, and the local cache is not flipped.
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(
        'Claim approved – payout sent from your wallet!'
      );
      expect(bounties.get('test-id')!.claims[0].status).toBe('pending');
    });
  });

  it('shows a benign success (never a failure) when the store says already-approved', async () => {
    // The exact double-toast bug: a duplicate approve of an already-paid claim
    // must show only a benign note, never "Failed to approve claim".
    (getNostrUserPubkey as jest.Mock).mockResolvedValue('creator-pubkey');
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      id: 'bounty-uuid',
      amountSats: 10000,
      testId: 'test-id',
      creatorId: 'creator-pubkey',
      claims: [{ status: 'pending' as ClaimStatus }],
    } as unknown as BountyInfo);
    const mockEmitter = { fire: jest.fn() } as any;

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, Approve Payout');
    (approveClaimApi as jest.Mock).mockResolvedValue('already-approved');

    approveClaimCommand(bounties, mockEmitter);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(bounties.get('test-id')!.claims[0].status).toBe('approved');
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringMatching(/already approved/i)
    );
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('shows a neutral "already being approved" note (no success, no failure) on in-progress', async () => {
    (getNostrUserPubkey as jest.Mock).mockResolvedValue('creator-pubkey');
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      id: 'bounty-uuid',
      amountSats: 10000,
      testId: 'test-id',
      creatorId: 'creator-pubkey',
      claims: [{ status: 'pending' as ClaimStatus }],
    } as unknown as BountyInfo);
    const mockEmitter = { fire: jest.fn() } as any;

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, Approve Payout');
    (approveClaimApi as jest.Mock).mockResolvedValue('in-progress');

    approveClaimCommand(bounties, mockEmitter);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringMatching(/already being approved/i)
    );
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    // Not our success to claim → don't falsely flip local state to approved.
    expect(bounties.get('test-id')!.claims[0].status).toBe('pending');
  });

  it('ignores a second approve for the same bounty while one is in flight', async () => {
    (getNostrUserPubkey as jest.Mock).mockResolvedValue('creator-pubkey');
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      id: 'bounty-uuid',
      amountSats: 10000,
      testId: 'test-id',
      creatorId: 'creator-pubkey',
      claims: [{ status: 'pending' as ClaimStatus }],
    } as unknown as BountyInfo);
    const mockEmitter = { fire: jest.fn() } as any;

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, Approve Payout');
    // Hold the first approve open so the second click lands while it's in flight.
    let resolveApprove!: (v: unknown) => void;
    (approveClaimApi as jest.Mock).mockReturnValue(
      new Promise((r) => { resolveApprove = r; })
    );

    approveClaimCommand(bounties, mockEmitter);
    const first = capturedHandler!(createMockTestItem({ id: 'test-id' }));
    // Let the first reach the in-flight approve call.
    await new Promise((r) => setImmediate(r));
    const second = capturedHandler!(createMockTestItem({ id: 'test-id' }));
    await second;

    // The second click was ignored — only one /approve request went out.
    expect(approveClaimApi).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringMatching(/already being approved/i)
    );

    resolveApprove({ id: 'bounty-uuid', claims: [{ status: 'approved' }] });
    await first;
    expect(approveClaimApi).toHaveBeenCalledTimes(1);
  });

  it('says "the claimant" when the payout address cannot be decrypted, and still pays the reviewed claim', async () => {
    (readClaimPayoutAddress as jest.Mock).mockResolvedValueOnce(undefined);
    (getNostrUserPubkey as jest.Mock).mockResolvedValue('creator-pubkey');
    // The destination is hidden for a private claim: no LNURL, flagged hidden.
    (getPendingClaimsApi as jest.Mock).mockResolvedValue([
      {
        id: MOCK_CLAIM_ID,
        claimantLnurl: null,
        claimantPubkey: MOCK_CLAIMANT_PUBKEY,
        claimedAt: new Date().toISOString(),
        status: 'pending',
        lnurlHidden: true,
      },
    ]);

    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      id: 'bounty-uuid',
      amountSats: 10000,
      testId: 'test-id',
      creatorId: 'creator-pubkey',
      claims: [{ status: 'pending' as ClaimStatus }],
    } as unknown as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, Approve Payout');
    (approveClaimApi as jest.Mock).mockResolvedValue({
      id: 'bounty-uuid',
      claims: [{ status: 'approved' }],
    });

    approveClaimCommand(bounties, mockEmitter);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    // The confirmation dialog names the payee generically and must never leak
    // the raw address anywhere in the message or its detail line.
    const [message, options] = (vscode.window.showWarningMessage as jest.Mock).mock.calls[0];
    expect(message).toContain('the claimant');
    expect(`${message} ${options?.detail ?? ''}`).not.toContain('@');
    // Approval still binds to the reviewed claim id and goes through.
    expect(approveClaimApi).toHaveBeenCalledWith(expect.objectContaining({ id: 'bounty-uuid' }), expect.objectContaining({ id: MOCK_CLAIM_ID, claimantPubkey: MOCK_CLAIMANT_PUBKEY }));
    expect(bounties.get('test-id')!.claims[0].status).toBe('approved');
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
    } as unknown as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, Approve Payout');
    (approveClaimApi as jest.Mock).mockRejectedValue(new Error('Server error'));

    approveClaimCommand(bounties, mockEmitter);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Approval error')
    );
  });

  it('does NOT show a success toast when approveClaim returns null (e.g. 502 payout failure)', async () => {
    // Regression: approveClaim() resolves null on failure (it shows its own
    // error toast). The command used to fire "payout triggered!" unconditionally,
    // producing a contradictory pair of toasts.
    (getNostrUserPubkey as jest.Mock).mockResolvedValue('creator-pubkey');
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      id: 'bounty-uuid',
      amountSats: 10000,
      testId: 'test-id',
      creatorId: 'creator-pubkey',
      claims: [{ status: 'pending' as ClaimStatus }],
    } as unknown as BountyInfo);

    const mockEmitter = { fire: jest.fn() } as any;

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, Approve Payout');
    (approveClaimApi as jest.Mock).mockResolvedValue(null); // payout failed

    approveClaimCommand(bounties, mockEmitter);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(
      'Claim approved – payout sent from your wallet!'
    );
    // Local state is left untouched — the claim is still pending.
    expect(bounties.get('test-id')!.claims[0].status).toBe('pending');
    expect(mockEmitter.fire).not.toHaveBeenCalled();
  });

  // ── NWC wallet precheck before approving ─────────────────────────────────
  function nwcBounty() {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      id: 'bounty-uuid',
      amountSats: 10000,
      testId: 'test-id',
      creatorId: 'creator-pubkey',
      claims: [{ status: 'pending' as ClaimStatus }],
    } as unknown as BountyInfo);
    return bounties;
  }

  it('wallet not connected: prompts to connect, then approves after connecting', async () => {
    (getNostrUserPubkey as jest.Mock).mockResolvedValue('creator-pubkey');
    const { getNwcStatus } = require('../api/nwc.api');
    // Not connected at first; connected after the connect-wallet command runs.
    (getNwcStatus as jest.Mock)
      .mockResolvedValueOnce({ configured: false })
      .mockResolvedValueOnce({ configured: true });

    const bounties = nwcBounty();
    const mockEmitter = { fire: jest.fn() } as any;
    // 1st warning = the connect-wallet prompt; 2nd = the approve confirm. The
    // wallet is checked first, so "pay" is never asked before it can happen.
    (vscode.window.showWarningMessage as jest.Mock)
      .mockResolvedValueOnce('Connect Wallet')
      .mockResolvedValueOnce('Yes, Approve Payout');
    (approveClaimApi as jest.Mock).mockResolvedValue({ id: 'bounty-uuid', claims: [{ status: 'approved' }] });

    approveClaimCommand(bounties, mockEmitter);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    const warnCalls = (vscode.window.showWarningMessage as jest.Mock).mock.calls;
    expect(warnCalls[0][0]).toMatch(/isn't connected/);
    expect(warnCalls[1][1]).toEqual(expect.objectContaining({ modal: true }));
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('sattest.connectWallet');
    expect(approveClaimApi).toHaveBeenCalledWith(expect.objectContaining({ id: 'bounty-uuid' }), expect.objectContaining({ id: MOCK_CLAIM_ID, claimantPubkey: MOCK_CLAIMANT_PUBKEY }));
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Claim approved – payout sent from your wallet!'
    );
  });

  it('wallet not connected: user declines the connect prompt → no approve call', async () => {
    (getNostrUserPubkey as jest.Mock).mockResolvedValue('creator-pubkey');
    const { getNwcStatus } = require('../api/nwc.api');
    (getNwcStatus as jest.Mock).mockResolvedValue({ configured: false });

    const bounties = nwcBounty();
    const mockEmitter = { fire: jest.fn() } as any;
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Cancel'); // declines the connect prompt

    approveClaimCommand(bounties, mockEmitter);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('sattest.connectWallet');
    expect(approveClaimApi).not.toHaveBeenCalled();
    // The payout confirm was never shown: the creator wasn't asked to say
    // "pay" for a payout that couldn't be sent.
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect((vscode.window.showWarningMessage as jest.Mock).mock.calls[0][0]).toMatch(
      /isn't connected/
    );
  });

  it('wallet still not connected after the connect attempt → warns, no approve call', async () => {
    (getNostrUserPubkey as jest.Mock).mockResolvedValue('creator-pubkey');
    const { getNwcStatus } = require('../api/nwc.api');
    (getNwcStatus as jest.Mock).mockResolvedValue({ configured: false }); // never connects

    const bounties = nwcBounty();
    const mockEmitter = { fire: jest.fn() } as any;
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Connect Wallet');

    approveClaimCommand(bounties, mockEmitter);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('sattest.connectWallet');
    expect(approveClaimApi).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('still not connected')
    );
    const modals = (vscode.window.showWarningMessage as jest.Mock).mock.calls.filter(
      ([, options]) => options?.modal
    );
    expect(modals).toHaveLength(0);
  });

  // ── Reviewing the claimant's changes ─────────────────────────────────────
  //
  // A modal blocks the whole window, so the payout confirm must never sit on
  // top of the diff it asks the creator to judge.
  function reviewableBounty() {
    const bounties = new Map<string, BountyInfo>();
    bounties.set('test-id', {
      id: 'bounty-uuid',
      amountSats: 10000,
      testId: 'test-id',
      creatorId: 'creator-pubkey',
      claims: [{ status: 'pending' as ClaimStatus }],
    } as unknown as BountyInfo);
    return bounties;
  }

  it('"Review changes" opens the diff and does not reopen the confirm over it', async () => {
    (getNostrUserPubkey as jest.Mock).mockResolvedValue('creator-pubkey');
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Review changes');
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValueOnce('Not now');

    approveClaimCommand(reviewableBounty(), { fire: jest.fn() } as any);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    // The patch is on screen…
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'diff', content: expect.stringContaining('+fixed') })
    );
    expect(vscode.window.showTextDocument).toHaveBeenCalled();
    // …with a non-modal way back to the decision, and no second modal on top.
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Reviewing the claim on "should do something": 10000 sats to lnurl1abc.',
      'Approve & Pay…',
      'Not now'
    );
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(approveClaimApi).not.toHaveBeenCalled();
  });

  it('"Approve & Pay…" after reviewing returns to the confirm and pays the same claim', async () => {
    (getNostrUserPubkey as jest.Mock).mockResolvedValue('creator-pubkey');
    (vscode.window.showWarningMessage as jest.Mock)
      .mockResolvedValueOnce('Review changes')
      .mockResolvedValueOnce('Yes, Approve Payout');
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValueOnce('Approve & Pay…');
    (approveClaimApi as jest.Mock).mockResolvedValue({
      id: 'bounty-uuid',
      claims: [{ status: 'approved' }],
    });

    approveClaimCommand(reviewableBounty(), { fire: jest.fn() } as any);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    // The confirm reopened only after the creator chose to come back to it.
    const warn = vscode.window.showWarningMessage as jest.Mock;
    const info = vscode.window.showInformationMessage as jest.Mock;
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][1]).toEqual(expect.objectContaining({ modal: true }));
    expect(info.mock.invocationCallOrder[0]).toBeLessThan(warn.mock.invocationCallOrder[1]);
    // Same claim and claimant; nothing refetched or re-checked in between.
    expect(approveClaimApi).toHaveBeenCalledWith(expect.objectContaining({ id: 'bounty-uuid' }), expect.objectContaining({ id: MOCK_CLAIM_ID, claimantPubkey: MOCK_CLAIMANT_PUBKEY }));
    expect(getPendingClaimsApi).toHaveBeenCalledTimes(1);
    const { verifyClaimTrailer } = require('../git/claim-trailer');
    expect(verifyClaimTrailer).toHaveBeenCalledTimes(1);
  });

  it('the review notification falls back to "the claimant" without a readable address', async () => {
    (readClaimPayoutAddress as jest.Mock).mockResolvedValueOnce(undefined);
    (getNostrUserPubkey as jest.Mock).mockResolvedValue('creator-pubkey');
    (getPendingClaimsApi as jest.Mock).mockResolvedValue([
      {
        id: MOCK_CLAIM_ID,
        claimantLnurl: null,
        claimantPubkey: MOCK_CLAIMANT_PUBKEY,
        claimedAt: new Date().toISOString(),
        status: 'pending',
        lnurlHidden: true,
      },
    ]);
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Review changes');
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValueOnce('Not now');

    approveClaimCommand(reviewableBounty(), { fire: jest.fn() } as any);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    const [reviewing] = (vscode.window.showInformationMessage as jest.Mock).mock.calls[0];
    expect(reviewing).toContain('to the claimant.');
    expect(reviewing).not.toContain('@');
  });

  it('falls straight back to the confirm when there is no diff to show', async () => {
    (getNostrUserPubkey as jest.Mock).mockResolvedValue('creator-pubkey');
    const { readCommitPatches } = require('../git/claim-trailer');
    (readCommitPatches as jest.Mock).mockReturnValueOnce('');
    (vscode.window.showWarningMessage as jest.Mock)
      .mockResolvedValueOnce('Review changes')
      .mockResolvedValueOnce(undefined); // then cancels the confirm

    approveClaimCommand(reviewableBounty(), { fire: jest.fn() } as any);
    await capturedHandler!(createMockTestItem({ id: 'test-id' }));

    // Nothing opened, so nothing to keep clear of: the confirm comes straight back.
    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'No changes to show for this claim.'
    );
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('Reviewing the claim'),
      expect.anything(),
      expect.anything()
    );
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(2);
    expect(approveClaimApi).not.toHaveBeenCalled();
  });
});
