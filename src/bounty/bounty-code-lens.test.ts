import * as vscode from 'vscode';
import { BountyCodeLensProvider } from './bounty-code-lens.js';
import { BountyInfo, ClaimInfo, claimStatusPending, claimStatusApproved } from './bounty.types.js';

jest.mock('../test/test-item.util', () => ({
  findTestItemById: jest.fn(),
  // The provider builds one index per render and resolves every bounty against
  // it; the mocked findTestItemById ignores it, so an empty map is enough.
  buildTestItemIndex: jest.fn(() => new Map()),
  testIdFilePath: (testId: string) => {
    const hashIndex = testId.indexOf('#');
    return hashIndex === -1 ? testId : testId.slice(0, hashIndex);
  },
}));

import { findTestItemById } from '../test/test-item.util.js';

function createBounty(overrides: Partial<BountyInfo> = {}): BountyInfo {
  return {
    id: 'bounty-1',
    coordinate: '37400:creator-pub:bounty-1',
    eventId: 'event-1',
    eventCreatedAt: 1000,
    amountSats: 5000,
    status: 'open',
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

    it('skips bounties whose test item is not in the test controller yet', () => {
      // findTestItemById returns undefined when the test was deleted, renamed,
      // or hasn't been discovered — we silently skip those.
      (findTestItemById as jest.Mock).mockReturnValue(undefined);
      bounties.set('missing-test', createBounty());
      provider = new BountyCodeLensProvider(bounties, emitter, undefined);

      const lenses = provider.provideCodeLenses(createMockDocument()) as vscode.CodeLens[];
      expect(lenses).toEqual([]);
    });

    it('setUserNostrPubkey: starts rendering Approve Claim after a late connect', () => {
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
          creatorId: 'late-pubkey',
          claims: [{ status: claimStatusPending } as ClaimInfo],
        })
      );
      // Provider built with no pubkey (simulating user hadn't connected at activation).
      provider = new BountyCodeLensProvider(bounties, emitter, undefined);

      let lenses = provider.provideCodeLenses(createMockDocument()) as vscode.CodeLens[];
      expect(lenses.find((l) => l.command?.title.includes('Approve Claim'))).toBeUndefined();

      // User connects → push the pubkey in.
      const fireSpy = jest.spyOn(provider._onDidChangeCodeLenses, 'fire');
      provider.setUserNostrPubkey('late-pubkey');
      expect(fireSpy).toHaveBeenCalled();

      lenses = provider.provideCodeLenses(createMockDocument()) as vscode.CodeLens[];
      expect(lenses.find((l) => l.command?.title.includes('Approve Claim'))).toBeDefined();
    });

    it('setUserNostrPubkey: skips refresh when pubkey is unchanged', () => {
      provider = new BountyCodeLensProvider(bounties, emitter, 'pub-1');
      const fireSpy = jest.spyOn(provider._onDidChangeCodeLenses, 'fire');
      provider.setUserNostrPubkey('pub-1');
      // No-op when nothing changed — avoids an unnecessary lens redraw.
      expect(fireSpy).not.toHaveBeenCalled();
    });

    it('never adds a "Non-custodial" badge — every bounty is non-custodial', () => {
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
        createBounty()
      );
      provider = new BountyCodeLensProvider(bounties, emitter, undefined);

      const lenses = provider.provideCodeLenses(createMockDocument()) as vscode.CodeLens[];
      const openLens = lenses.find((l) => l.command?.title.includes('Open Bounty'));
      expect(openLens).toBeDefined();
      expect(lenses.every((l) => !l.command?.title.includes('Non-custodial'))).toBe(true);
    });

    it('fires onDidChangeCodeLenses when the bounty emitter fires', () => {
      provider = new BountyCodeLensProvider(bounties, emitter, undefined);
      const fired = jest.fn();
      provider._onDidChangeCodeLenses.event = fired as any;
      // The constructor wired emitter.event(...) — invoke the captured listener.
      const listener = (emitter.event as jest.Mock).mock.calls[0][0];
      const fireSpy = jest.spyOn(provider._onDidChangeCodeLenses, 'fire');
      listener();
      expect(fireSpy).toHaveBeenCalled();
    });
  });

  describe('resolveCodeLens (extra)', () => {
    it('returns the codeLens unchanged even when token is non-trivial', () => {
      provider = new BountyCodeLensProvider(bounties, emitter, undefined);
      const lens = new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        title: 'x',
        command: '',
      });
      const token = { isCancellationRequested: false } as vscode.CancellationToken;
      expect(provider.resolveCodeLens!(lens, token)).toBe(lens);
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

      bounties.set('test-1', createBounty());
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

      bounties.set('test-1', createBounty({ active: false }));
      provider = new BountyCodeLensProvider(bounties, emitter, undefined);

      const doc = createMockDocument();
      const lenses = provider.provideCodeLenses(doc) as vscode.CodeLens[];
      expect(lenses).toEqual([]);
    });

    it('shows nothing for a cancelled bounty', () => {
      const uri = vscode.Uri.file('/mock/workspace/foo.test.ts');
      (findTestItemById as jest.Mock).mockReturnValue({
        id: 'test-1',
        label: 'my test',
        uri,
        range: new vscode.Range(5, 0, 5, 10),
        children: [],
      });
      bounties.set('test-1', createBounty({ status: 'cancelled', active: false }));
      provider = new BountyCodeLensProvider(bounties, emitter, 'creator-pub');

      expect(provider.provideCodeLenses(createMockDocument())).toEqual([]);
    });

    it('shows an "Open Bounty – Claimable" lens for an open bounty', () => {
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
        })
      );
      provider = new BountyCodeLensProvider(bounties, emitter, undefined);

      const doc = createMockDocument();
      const lenses = provider.provideCodeLenses(doc) as vscode.CodeLens[];

      const fundedLens = lenses.find((l) => l.command?.title.includes('Open Bounty'));
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
          claims: [{ status: claimStatusPending } as ClaimInfo],
        })
      );
      provider = new BountyCodeLensProvider(bounties, emitter, undefined);

      const doc = createMockDocument();
      const lenses = provider.provideCodeLenses(doc) as vscode.CodeLens[];

      const pendingLens = lenses.find((l) => l.command?.title.includes('Claim Pending'));
      expect(pendingLens).toBeDefined();
    });

    it('shows a non-actionable "Payout Processing" lens while a claim is approving', () => {
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
          claims: [{ status: 'approving' } as ClaimInfo],
        })
      );
      provider = new BountyCodeLensProvider(bounties, emitter, undefined);

      const lenses = provider.provideCodeLenses(createMockDocument()) as vscode.CodeLens[];

      const processingLens = lenses.find((l) => l.command?.title.includes('Payout Processing'));
      expect(processingLens).toBeDefined();
      expect(processingLens?.command?.command).toBe('');
      // Crucially, a bounty mid-payout is NOT offered as claimable again.
      const claimable = lenses.find((l) => l.command?.command === 'sattest.claimBounty');
      expect(claimable).toBeUndefined();
    });

    it('lets the CREATOR click the "Payout Processing" lens to re-check a held payout', () => {
      // A payout whose outcome was never confirmed leaves the claim locked. The
      // creator needs a way to ask their wallet what happened — without this the
      // claim stays stuck, which is exactly the dead end this lens is here to
      // prevent. (The payout code still reconciles before paying, so the click
      // can't double-spend.)
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
          creatorId: 'creator-pub',
          claims: [{ status: 'approving' } as ClaimInfo],
        })
      );
      // Viewing as the creator this time.
      provider = new BountyCodeLensProvider(bounties, emitter, 'creator-pub');

      const lenses = provider.provideCodeLenses(createMockDocument()) as vscode.CodeLens[];

      const processingLens = lenses.find((l) => l.command?.title.includes('Payout Processing'));
      expect(processingLens?.command?.command).toBe('sattest.approveClaim');
      expect(processingLens?.command?.tooltip).toMatch(/re-check/i);
      // Still not re-claimable, and no separate "Approve Claim" lens appears.
      expect(lenses.find((l) => l.command?.command === 'sattest.claimBounty')).toBeUndefined();
      expect(lenses.filter((l) => l.command?.command === 'sattest.approveClaim')).toHaveLength(1);
    });

    it('Approve Claim lens passes the TestItem (not the testId string) as the first command arg', () => {
      // Regression: passing `[testId, item]` here meant the click handler
      // received a string, did `string.id` → undefined, and toasted
      // "No test selected" instead of opening the approve confirmation.
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
          creatorId: 'my-pubkey',
          claims: [{ status: claimStatusPending } as ClaimInfo],
        })
      );
      provider = new BountyCodeLensProvider(bounties, emitter, 'my-pubkey');
      const lenses = provider.provideCodeLenses(createMockDocument()) as vscode.CodeLens[];
      const approveLens = lenses.find((l) => l.command?.title.includes('Approve Claim'));

      expect(approveLens?.command?.arguments).toEqual([mockItem]);
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
          claims: [{ status: claimStatusApproved } as ClaimInfo],
        })
      );
      provider = new BountyCodeLensProvider(bounties, emitter, undefined);

      const doc = createMockDocument();
      const lenses = provider.provideCodeLenses(doc) as vscode.CodeLens[];

      const approvedLens = lenses.find((l) => l.command?.title.includes('Claim Approved'));
      expect(approvedLens).toBeDefined();
    });

    it('shows the "Remove Bounty" lens to the creator', () => {
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
        })
      );
      provider = new BountyCodeLensProvider(bounties, emitter, 'creator-pub');

      const doc = createMockDocument();
      const lenses = provider.provideCodeLenses(doc) as vscode.CodeLens[];

      const removeLens = lenses.find((l) => l.command?.title.includes('Remove Bounty'));
      expect(removeLens).toBeDefined();
      expect(removeLens?.command?.command).toBe('sattest.removeBounty');
    });

    it('labels the remove lens "Remove Paid Bounty" when the claim is approved', () => {
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
          creatorId: 'creator-pub',
          claims: [{ status: claimStatusApproved } as ClaimInfo],
        })
      );
      // Creator view → the remove lens renders even for a paid bounty.
      provider = new BountyCodeLensProvider(bounties, emitter, 'creator-pub');

      const lenses = provider.provideCodeLenses(createMockDocument()) as vscode.CodeLens[];
      const removeLens = lenses.find((l) => l.command?.command === 'sattest.removeBounty');
      expect(removeLens?.command?.title).toBe('🗑️ Remove Paid Bounty');
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
        })
      );
      provider = new BountyCodeLensProvider(bounties, emitter, undefined);

      const doc = createMockDocument();
      const lenses = provider.provideCodeLenses(doc) as vscode.CodeLens[];

      expect(lenses.length).toBeGreaterThan(0);
    });

    it('skips a closed bounty with no claim to show', () => {
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
          status: 'paid',
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
