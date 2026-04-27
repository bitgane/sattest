import * as vscode from 'vscode';
import { promptForLnurl } from './lnurl-input.js';

describe('promptForLnurl', () => {
  beforeEach(() => {
    (vscode.window.showInputBox as jest.Mock).mockReset();
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
    const result = await promptForLnurl('t', 'p');
    expect(result).toBeUndefined();
  });

  it('returns undefined when user submits whitespace only', async () => {
    (vscode.window.showInputBox as jest.Mock).mockResolvedValue('   ');
    const result = await promptForLnurl('t', 'p');
    expect(result).toBeUndefined();
  });

  describe('validateInput', () => {
    function getValidator(): (v: string) => string | null {
      // Trigger the call so we can grab the validator the prod code passes in.
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue(undefined);
      void promptForLnurl('t', 'p');
      const opts = (vscode.window.showInputBox as jest.Mock).mock.calls[0][0];
      return opts.validateInput;
    }

    it('accepts an lnurl-prefixed string', () => {
      const validate = getValidator();
      expect(validate('lnurl1abcd')).toBeNull();
      expect(validate('  lnurl1abcd  ')).toBeNull(); // trim handled internally
    });

    it('accepts a Lightning address', () => {
      const validate = getValidator();
      expect(validate('alice@primal.net')).toBeNull();
      expect(validate('a.b+c@sub.domain.io')).toBeNull();
    });

    it('rejects a malformed value', () => {
      const validate = getValidator();
      expect(validate('not-an-lnurl')).toMatch(/not a valid format/);
      expect(validate('alice@')).toMatch(/not a valid format/);
      expect(validate('@primal.net')).toMatch(/not a valid format/);
      expect(validate('')).toMatch(/not a valid format/);
    });
  });
});
