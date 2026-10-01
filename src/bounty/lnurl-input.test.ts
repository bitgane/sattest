import * as vscode from 'vscode';
import { promptForLnurl } from './lnurl-input.js';
import { getLnurlLimits } from '../api/bounty.api.js';

jest.mock('../api/bounty.api', () => ({
  getLnurlLimits: jest.fn(),
}));

const mockGetLnurlLimits = getLnurlLimits as jest.Mock;

describe('promptForLnurl', () => {
  beforeEach(() => {
    (vscode.window.showInputBox as jest.Mock).mockReset();
    mockGetLnurlLimits.mockReset();
  });

  it('returns the trimmed value the user enters', async () => {
    (vscode.window.showInputBox as jest.Mock).mockResolvedValue('  alice@primal.net  ');
    const result = await promptForLnurl('title', 'enter lnurl');
    expect(result).toBe('alice@primal.net');
    expect(vscode.window.showInputBox).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'title', prompt: 'enter lnurl' })
    );
  });

  it('returns undefined when user dismisses the prompt', async () => {
    (vscode.window.showInputBox as jest.Mock).mockResolvedValue(undefined);
    expect(await promptForLnurl('t', 'p')).toBeUndefined();
  });

  it('returns undefined when user submits whitespace only', async () => {
    (vscode.window.showInputBox as jest.Mock).mockResolvedValue('   ');
    expect(await promptForLnurl('t', 'p')).toBeUndefined();
  });

  // Grab the validateInput callback the prod code hands to showInputBox.
  function getValidator(
    opts?: { amountSats?: number }
  ): (v: string) => Promise<string | vscode.InputBoxValidationMessage | null | undefined> {
    (vscode.window.showInputBox as jest.Mock).mockResolvedValue(undefined);
    void promptForLnurl('t', 'p', opts);
    const passed = (vscode.window.showInputBox as jest.Mock).mock.calls.at(-1)![0];
    return passed.validateInput;
  }

  describe('validateInput — format (no amountSats)', () => {
    it('accepts an lnurl-prefixed string', async () => {
      const validate = getValidator();
      expect(await validate('lnurl1abcd')).toBeNull();
      expect(await validate('  lnurl1abcd  ')).toBeNull();
    });

    it('accepts a Lightning address', async () => {
      const validate = getValidator();
      expect(await validate('alice@primal.net')).toBeNull();
      expect(await validate('a.b+c@sub.domain.io')).toBeNull();
    });

    it('rejects a malformed value', async () => {
      const validate = getValidator();
      expect(await validate('not-an-lnurl')).toMatch(/not a valid format/);
      expect(await validate('alice@')).toMatch(/not a valid format/);
      expect(await validate('@primal.net')).toMatch(/not a valid format/);
      expect(await validate('')).toMatch(/not a valid format/);
    });

    it('never resolves limits when no amountSats is supplied', async () => {
      const validate = getValidator();
      await validate('alice@primal.net');
      expect(mockGetLnurlLimits).not.toHaveBeenCalled();
    });
  });

  describe('validateInput — amount range (amountSats supplied)', () => {
    it('blocks when the minimum sendable is higher than the bounty', async () => {
      // 5000-sat minimum (5_000_000 msat) vs a 1000-sat bounty.
      mockGetLnurlLimits.mockResolvedValue({ minSendable: 5_000_000, maxSendable: 100_000_000 });
      const validate = getValidator({ amountSats: 1000 });
      expect(await validate('alice@primal.net')).toMatch(
        /minimum sendable amount of 5000 sats, higher than the 1000 sat bounty/
      );
    });

    it('blocks when the maximum sendable is lower than the bounty', async () => {
      // 500-sat maximum (500_000 msat) vs a 1000-sat bounty.
      mockGetLnurlLimits.mockResolvedValue({ minSendable: 1000, maxSendable: 500_000 });
      const validate = getValidator({ amountSats: 1000 });
      expect(await validate('alice@primal.net')).toMatch(/only accepts up to 500 sats/);
    });

    it('accepts when the amount is within the sendable range', async () => {
      mockGetLnurlLimits.mockResolvedValue({ minSendable: 1000, maxSendable: 100_000_000 });
      const validate = getValidator({ amountSats: 1000 });
      expect(await validate('alice@primal.net')).toBeNull();
    });

    it('fails open (accepts) when limits cannot be resolved', async () => {
      mockGetLnurlLimits.mockResolvedValue(null);
      const validate = getValidator({ amountSats: 1000 });
      expect(await validate('alice@primal.net')).toBeNull();
    });

    it('caches per value — resolves once for repeated identical input', async () => {
      mockGetLnurlLimits.mockResolvedValue({ minSendable: 1000, maxSendable: 100_000_000 });
      const validate = getValidator({ amountSats: 1000 });
      await validate('alice@primal.net');
      await validate('alice@primal.net');
      await validate('alice@primal.net');
      expect(mockGetLnurlLimits).toHaveBeenCalledTimes(1);
    });

    it('rejects malformed input before any network call', async () => {
      const validate = getValidator({ amountSats: 1000 });
      expect(await validate('bad')).toMatch(/not a valid format/);
      expect(mockGetLnurlLimits).not.toHaveBeenCalled();
    });
  });
});
