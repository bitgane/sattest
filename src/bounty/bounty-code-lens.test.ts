import * as vscode from 'vscode';
import { BountyCodeLensProvider } from './bounty-code-lens.js';
import { BountyInfo, ClaimInfo, claimStatusPending, claimStatusApproved } from './bounty.types.js';

jest.mock('../test/test-item.util', () => ({
  findTestItemById: jest.fn(),
}));

import { findTestItemById } from '../test/test-item.util.js';

function createBounty(overrides: Partial<BountyInfo> = {}): BountyInfo {
  return {
    id: 'bounty-1',
    amountSats: 5000,
    invoice: 'lnbc...',
    paymentHash: 'hash123',
    createdAt: new Date(),
    creatorId: 'creator-pub',
    testId: 'test-1',
    claims: [],
    active: true,
    ...overrides,
  };
}

function createMockDocument(uriPath = '/mock/workspace/foo.test.ts'): vscode.TextDocument {
  return {
    uri: vscode.Uri.file(uriPath),
    languageId: 'typescript',
  } as any;
}

describe('BountyCodeLensProvider', () => {
  let bounties: Map<string, BountyInfo>;
  let emitter: vscode.EventEmitter<void>;
  let provider: BountyCodeLensProvider;

  beforeEach(() => {
    bounties = new Map();
    emitter = new vscode.EventEmitter<void>();
  });

  describe('constructor', () => {
    it('creates provider and listens to bounty changes', () => {
      provider = new BountyCodeLensProvider(bounties, emitter, undefined);
      expect(provider).toBeDefined();
      expect(provider._onDidChangeCodeLenses).toBeDefined();
    });
  });

  describe('provideCodeLenses', () => {
    it('returns empty array when no bounties match document', () => {
      provider = new BountyCodeLensProvider(bounties, emitter, undefined);
      const doc = createMockDocument();

      const lenses = provider.provideCodeLenses(doc) as vscode.CodeLens[];
      expect(lenses).toEqual([]);
    });

    it('skips bounties for different documents', () => {
      const mockItem = {
        id: 'test-1',
        label: 'test',
        uri: vscode.Uri.file('/other/file.test.ts'),
        range: new vscode.Range(5, 0, 5, 10),
        children: [],
      };
      (findTestItemById as jest.Mock).mockReturnValue(mockItem);

      bounties.set('test-1', createBounty({ paymentHash: 'hash' }));
      provider = new BountyCodeLensProvider(bounties, emitter, undefined);

      const doc = createMockDocument('/mock/workspace/foo.test.ts');
      const lenses = provider.provideCodeLenses(doc) as vscode.CodeLens[];
      expect(lenses).toEqual([]);
    });

    it('skips inactive bounties', () => {
      const mockItem = {
        id: 'test-1',
        label: 'test',
        uri: vscode.Uri.file('/mock/workspace/foo.test.ts'),
        range: new vscode.Range(5, 0, 5, 10),
        children: [],
      };
      (findTestItemById as jest.Mock).mockReturnValue(mockItem);

      bounties.set('test-1', createBounty({ active: false, paymentHash: 'hash' }));
      provider = new BountyCodeLensProvider(bounties, emitter, undefined);

      const doc = createMockDocument();
      const lenses = provider.provideCodeLenses(doc) as vscode.CodeLens[];
      expect(lenses).toEqual([]);
    });

    it('shows "Awaiting Funding" lens for unfunded bounty with paymentHash', () => {
      const uri = vscode.Uri.file('/mock/workspace/foo.test.ts');
      const mockItem = {
        id: 'test-1',
        label: 'my test',
        uri,
        range: new vscode.Range(5, 0, 5, 10),
        children: [],
      };
      (findTestItemById as jest.Mock).mockReturnValue(mockItem);

      bounties.set(
        'test-1',
        createBounty({
          invoicePaid: false,
          paymentHash: 'hash',
          amountSats: 5000,
        })
      );
      provider = new BountyCodeLensProvider(bounties, emitter, undefined);

      const doc = createMockDocument();
      const lenses = provider.provideCodeLenses(doc) as vscode.CodeLens[];

      // Should have "Awaiting Funding" + "Remove Bounty" lenses
      expect(lenses.length).toBeGreaterThanOrEqual(1);
      const awaitingLens = lenses.find((l) => l.command?.title.includes('Awaiting Funding'));
      expect(awaitingLens).toBeDefined();
      expect(awaitingLens?.command?.command).toBe('sattest.checkPaid');
    });

    it('shows "Funded – Claimable" lens for paid bounty', () => {
      const uri = vscode.Uri.file('/mock/workspace/foo.test.ts');
      const mockItem = {
        id: 'test-1',
        label: 'my test',
        uri,
        range: new vscode.Range(5, 0, 5, 10),
        children: [],
      };
      (findTestItemById as jest.Mock).mockReturnValue(mockItem);

      bounties.set(
        'test-1',
        createBounty({
          invoicePaid: true,
          paymentHash: 'hash',
        })
      );
      provider = new BountyCodeLensProvider(bounties, emitter, undefined);

      const doc = createMockDocument();
      const lenses = provider.provideCodeLenses(doc) as vscode.CodeLens[];

      const fundedLens = lenses.find((l) => l.command?.title.includes('Funded'));
      expect(fundedLens).toBeDefined();
      expect(fundedLens?.command?.command).toBe('sattest.claimBounty');
    });

    it('shows "Claim Pending" lens when claim is pending', () => {
      const uri = vscode.Uri.file('/mock/workspace/foo.test.ts');
      const mockItem = {
        id: 'test-1',
        label: 'my test',
        uri,
        range: new vscode.Range(5, 0, 5, 10),
        children: [],
      };
      (findTestItemById as jest.Mock).mockReturnValue(mockItem);

      bounties.set(
        'test-1',
        createBounty({
          invoicePaid: true,
          paymentHash: 'hash',
          claims: [{ status: claimStatusPending } as ClaimInfo],
        })
      );
      provider = new BountyCodeLensProvider(bounties, emitter, undefined);

      const doc = createMockDocument();
      const lenses = provider.provideCodeLenses(doc) as vscode.CodeLens[];

      const pendingLens = lenses.find((l) => l.command?.title.includes('Claim Pending'));
      expect(pendingLens).toBeDefined();
    });

    it('shows "Approve Claim" lens when creator views pending claim', () => {
      const uri = vscode.Uri.file('/mock/workspace/foo.test.ts');
      const mockItem = {
        id: 'test-1',
        label: 'my test',
        uri,
        range: new vscode.Range(5, 0, 5, 10),
        children: [],
      };
      (findTestItemById as jest.Mock).mockReturnValue(mockItem);

      bounties.set(
        'test-1',
        createBounty({
          invoicePaid: true,
          paymentHash: 'hash',
          creatorId: 'my-pubkey',
          claims: [{ status: claimStatusPending } as ClaimInfo],
        })
      );
      provider = new BountyCodeLensProvider(bounties, emitter, 'my-pubkey');

      const doc = createMockDocument();
      const lenses = provider.provideCodeLenses(doc) as vscode.CodeLens[];

      const approveLens = lenses.find((l) => l.command?.title.includes('Approve Claim'));
      expect(approveLens).toBeDefined();
      expect(approveLens?.command?.command).toBe('sattest.approveClaim');
    });

    it('does not show "Approve Claim" for non-creator', () => {
      const uri = vscode.Uri.file('/mock/workspace/foo.test.ts');
      const mockItem = {
        id: 'test-1',
        label: 'my test',
        uri,
        range: new vscode.Range(5, 0, 5, 10),
        children: [],
      };
      (findTestItemById as jest.Mock).mockReturnValue(mockItem);

      bounties.set(
        'test-1',
        createBounty({
          invoicePaid: true,
          paymentHash: 'hash',
          creatorId: 'other-pubkey',
          claims: [{ status: claimStatusPending } as ClaimInfo],
        })
      );
      provider = new BountyCodeLensProvider(bounties, emitter, 'my-pubkey');

      const doc = createMockDocument();
      const lenses = provider.provideCodeLenses(doc) as vscode.CodeLens[];

      const approveLens = lenses.find((l) => l.command?.title.includes('Approve Claim'));
      expect(approveLens).toBeUndefined();
    });

    it('shows "Claim Approved" lens when claim is approved', () => {
      const uri = vscode.Uri.file('/mock/workspace/foo.test.ts');
      const mockItem = {
        id: 'test-1',
        label: 'my test',
        uri,
        range: new vscode.Range(5, 0, 5, 10),
        children: [],
      };
      (findTestItemById as jest.Mock).mockReturnValue(mockItem);

      bounties.set(
        'test-1',
        createBounty({
          invoicePaid: true,
          paymentHash: 'hash',
          claims: [{ status: claimStatusApproved } as ClaimInfo],
        })
      );
      provider = new BountyCodeLensProvider(bounties, emitter, undefined);

      const doc = createMockDocument();
      const lenses = provider.provideCodeLenses(doc) as vscode.CodeLens[];

      const approvedLens = lenses.find((l) => l.command?.title.includes('Claim Approved'));
      expect(approvedLens).toBeDefined();
    });

    it('shows "Remove Bounty" lens for unfunded bounty', () => {
      const uri = vscode.Uri.file('/mock/workspace/foo.test.ts');
      const mockItem = {
        id: 'test-1',
        label: 'my test',
        uri,
        range: new vscode.Range(5, 0, 5, 10),
        children: [],
      };
      (findTestItemById as jest.Mock).mockReturnValue(mockItem);

      bounties.set(
        'test-1',
        createBounty({
          invoicePaid: false,
          paymentHash: 'hash',
        })
      );
      provider = new BountyCodeLensProvider(bounties, emitter, undefined);

      const doc = createMockDocument();
      const lenses = provider.provideCodeLenses(doc) as vscode.CodeLens[];

      const removeLens = lenses.find((l) => l.command?.title.includes('Remove Bounty'));
      expect(removeLens).toBeDefined();
      expect(removeLens?.command?.command).toBe('sattest.removeBounty');
    });

    it('uses fallback range when item has no range', () => {
      const uri = vscode.Uri.file('/mock/workspace/foo.test.ts');
      const mockItem = {
        id: 'test-1',
        label: 'my test',
        uri,
        range: undefined, // no range
        children: [],
      };
      (findTestItemById as jest.Mock).mockReturnValue(mockItem);

      bounties.set(
        'test-1',
        createBounty({
          invoicePaid: true,
          paymentHash: 'hash',
        })
      );
      provider = new BountyCodeLensProvider(bounties, emitter, undefined);

      const doc = createMockDocument();
      const lenses = provider.provideCodeLenses(doc) as vscode.CodeLens[];

      expect(lenses.length).toBeGreaterThan(0);
    });

    it('skips bounties with no paymentHash and not pending/approved', () => {
      const uri = vscode.Uri.file('/mock/workspace/foo.test.ts');
      const mockItem = {
        id: 'test-1',
        label: 'my test',
        uri,
        range: new vscode.Range(5, 0, 5, 10),
        children: [],
      };
      (findTestItemById as jest.Mock).mockReturnValue(mockItem);

      bounties.set(
        'test-1',
        createBounty({
          invoicePaid: false,
          paymentHash: undefined, // no payment hash
          claims: [],
        })
      );
      provider = new BountyCodeLensProvider(bounties, emitter, undefined);

      const doc = createMockDocument();
      const lenses = provider.provideCodeLenses(doc) as vscode.CodeLens[];

      expect(lenses).toEqual([]);
    });
  });

  describe('resolveCodeLens', () => {
    it('returns the codeLens unchanged', () => {
      provider = new BountyCodeLensProvider(bounties, emitter, undefined);
      const lens = new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        title: 'test',
        command: 'test',
      });
      const token = {} as vscode.CancellationToken;

      const result = provider.resolveCodeLens!(lens, token);
      expect(result).toBe(lens);
    });
  });
});
