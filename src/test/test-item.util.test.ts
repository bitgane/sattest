import * as vscode from 'vscode';
import {
  findTestItemById,
  workspaceRoot,
  removeParentLabelFromTestId,
  relativeTestPath,
  normalizedTestPath,
  normalizedTestId,
  parseRepoSlug,
  getLocalTestIds,
} from './test-item.util.js';
import { myTestController } from './test-controller.js';

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

// We need to mock the test-controller module before importing test-item.util
jest.mock('./test-controller', () => {
  const items = new Map();
  return {
    myTestController: {
      items: {
        _items: items,
        forEach: jest.fn().mockImplementation((cb: any) => {
          items.forEach((value: any, key: any) => cb(value, key));
        }),
        add: jest.fn().mockImplementation((item: any) => {
          items.set(item.id, item);
        }),
        replace: jest.fn().mockImplementation((newItems: any[]) => {
          items.clear();
          newItems.forEach((item: any) => items.set(item.id, item));
        }),
        get size() {
          return items.size;
        },
      },
      createTestItem: jest.fn(),
    },
  };
});

describe('workspaceRoot', () => {
  it('returns workspace folder fsPath', () => {
    const root = workspaceRoot();
    expect(root).toBe('/mock/workspace');
  });

  it('returns empty string when no workspace folders', () => {
    const originalFolders = vscode.workspace.workspaceFolders;
    (vscode.workspace as any).workspaceFolders = undefined;

    const root = workspaceRoot();
    expect(root).toBe('');

    (vscode.workspace as any).workspaceFolders = originalFolders;
  });
});

describe('removeParentLabelFromTestId', () => {
  it('returns testId unchanged when no parent', () => {
    const test = { id: 'file.test.ts#myTest', parent: undefined } as any;
    expect(removeParentLabelFromTestId(test)).toBe('file.test.ts#myTest');
  });

  it('returns testId unchanged when parent has no id', () => {
    const test = { id: 'file.test.ts#myTest', parent: { id: '' } } as any;
    expect(removeParentLabelFromTestId(test)).toBe('file.test.ts#myTest');
  });

  it('returns testId unchanged when testId has no hash', () => {
    const test = { id: 'file.test.ts', parent: { id: 'parent-id' } } as any;
    expect(removeParentLabelFromTestId(test)).toBe('file.test.ts');
  });

  it('returns parent id when parentId has no hash', () => {
    const test = {
      id: 'file.test.ts#parentLabel > myTest',
      parent: { id: 'file.test.ts' },
    } as any;
    expect(removeParentLabelFromTestId(test)).toBe('file.test.ts#parentLabel > myTest');
  });

  it('removes parent label from test id when matching prefix', () => {
    const test = {
      id: '/path/file.test.ts#describe > it test',
      parent: { id: '/path/file.test.ts#describe' },
    } as any;
    const result = removeParentLabelFromTestId(test);
    expect(result).toBe('/path/file.test.ts#> it test');
  });
});

describe('relativeTestPath', () => {
  it('returns relative path from workspace root', () => {
    const test = {
      uri: { fsPath: '/mock/workspace/src/foo.test.ts' },
    } as any;
    expect(relativeTestPath(test)).toBe('/src/foo.test.ts');
  });

  it('returns fallback when no uri', () => {
    const test = { uri: undefined } as any;
    expect(relativeTestPath(test)).toBe('unknown/test-file.test.ts');
  });
});

describe('normalizedTestPath', () => {
  it('returns path with leading slash', () => {
    const test = {
      uri: { fsPath: '/mock/workspace/src/foo.test.ts' },
    } as any;
    expect(normalizedTestPath(test)).toBe('/src/foo.test.ts');
  });

  it('adds leading slash when missing', () => {
    const originalFolders = vscode.workspace.workspaceFolders;
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '' } }];

    const test = {
      uri: { fsPath: 'src/foo.test.ts' },
    } as any;
    expect(normalizedTestPath(test)).toBe('/src/foo.test.ts');

    (vscode.workspace as any).workspaceFolders = originalFolders;
  });
});

describe('normalizedTestId', () => {
  it('returns test.id when it does not start with workspace root', () => {
    const test = {
      id: 'some-other-id',
      uri: { fsPath: '/mock/workspace/src/foo.test.ts' },
    } as any;
    expect(normalizedTestId(test)).toBe('some-other-id');
  });

  it('normalizes test id to relative path with hash', () => {
    const test = {
      id: '/mock/workspace/src/foo.test.ts#myTest',
      uri: { fsPath: '/mock/workspace/src/foo.test.ts' },
    } as any;
    expect(normalizedTestId(test)).toBe('/src/foo.test.ts#myTest');
  });

  it('returns original testId when no hash present', () => {
    const test = {
      id: '/mock/workspace/src/foo.test.ts',
      uri: { fsPath: '/mock/workspace/src/foo.test.ts' },
    } as any;
    const result = normalizedTestId(test);
    // Without a hash, the original testId is returned unchanged
    expect(result).toBe('/mock/workspace/src/foo.test.ts');
  });
});

describe('findTestItemById', () => {
  beforeEach(() => {
    // Clear the controller items
    (myTestController.items as any)._items.clear();
  });

  it('returns a wrapper for a matching test item', () => {
    const mockChild = {
      id: 'file.test.ts#myTest',
      label: 'myTest',
      uri: vscode.Uri.file('/mock/workspace/file.test.ts'),
      range: new vscode.Range(10, 0, 10, 20),
      children: {
        forEach: jest.fn(),
      },
    };

    const mockFileItem = {
      id: 'file.test.ts',
      label: 'file.test.ts',
      uri: vscode.Uri.file('/mock/workspace/file.test.ts'),
      children: {
        forEach: jest.fn().mockImplementation((cb: any) => cb(mockChild)),
      },
    };

    // Override forEach for controller items to return our mock
    (myTestController.items.forEach as jest.Mock).mockImplementation((cb: any) => {
      cb(mockFileItem, mockFileItem.id);
    });

    const result = findTestItemById('file.test.ts#myTest');
    expect(result).toBeDefined();
    expect(result.id).toBe('file.test.ts#myTest');
    expect(result.label).toBe('myTest');
  });

  it('returns dummy wrapper when no item found', () => {
    (myTestController.items.forEach as jest.Mock).mockImplementation(() => {});

    const result = findTestItemById('nonexistent-test');
    expect(result).toBeDefined();
    expect(result.id).toBe('nonexistent-test');
    expect(result.label).toBe('Unknown Test');
  });
});

describe('parseRepoSlug', () => {
  it('parses HTTPS GitHub URL', () => {
    expect(parseRepoSlug('https://github.com/owner/repo.git')).toBe('owner/repo');
  });

  it('parses HTTPS URL without .git suffix', () => {
    expect(parseRepoSlug('https://github.com/owner/repo')).toBe('owner/repo');
  });

  it('parses SSH URL', () => {
    expect(parseRepoSlug('git@github.com:owner/repo.git')).toBe('owner/repo');
  });

  it('parses SSH URL without .git suffix', () => {
    expect(parseRepoSlug('git@github.com:owner/repo')).toBe('owner/repo');
  });

  it('parses GitLab SSH URL', () => {
    expect(parseRepoSlug('git@gitlab.com:team/project.git')).toBe('team/project');
  });

  it('parses URL with credentials', () => {
    expect(parseRepoSlug('http://user@host:3000/git/owner/repo')).toBe('owner/repo');
  });

  it('returns empty string for unrecognized format', () => {
    expect(parseRepoSlug('not-a-url')).toBe('');
  });
});

describe('getRepoSlug', () => {
  // getRepoSlug memoizes — re-import per test to clear the cache.
  let getRepoSlug: typeof import('./test-item.util.js').getRepoSlug;
  let execFile: jest.Mock;

  /** Make the mocked `git remote get-url origin` print `stdout`, or fail with `error`. */
  function gitAnswers(result: { stdout?: string; error?: Error }) {
    execFile.mockImplementation((_cmd: string, _args: string[], _opts: object, callback: Function) =>
      callback(result.error ?? null, result.stdout ?? '', '')
    );
  }

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('child_process', () => ({ execFile: jest.fn() }));
    jest.doMock('./test-controller', () => ({
      myTestController: { items: { forEach: jest.fn(), get size() { return 0; } } },
    }));
    getRepoSlug = require('./test-item.util.js').getRepoSlug;
    execFile = require('child_process').execFile;
  });

  it('returns slug parsed from `git remote get-url origin`', async () => {
    gitAnswers({ stdout: 'git@github.com:bitgane/sattest.git\n' });
    await expect(getRepoSlug()).resolves.toBe('bitgane/sattest');
    // Argument array, no shell: nothing from the workspace reaches a command line.
    expect(execFile).toHaveBeenCalledWith(
      'git',
      ['remote', 'get-url', 'origin'],
      expect.objectContaining({ cwd: '/mock/workspace', timeout: 5000 }),
      expect.any(Function)
    );
  });

  it('memoizes the result — second call does not re-run git', async () => {
    gitAnswers({ stdout: 'git@github.com:owner/repo.git\n' });
    await expect(getRepoSlug()).resolves.toBe('owner/repo');
    execFile.mockClear();
    await expect(getRepoSlug()).resolves.toBe('owner/repo');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('shares one git call between concurrent callers', async () => {
    let answer!: () => void;
    execFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, callback: Function) => {
        answer = () => callback(null, 'git@github.com:owner/repo.git\n', '');
      }
    );

    const first = getRepoSlug();
    const second = getRepoSlug();
    answer();

    await expect(Promise.all([first, second])).resolves.toEqual(['owner/repo', 'owner/repo']);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when git is unavailable', async () => {
    gitAnswers({ error: new Error('not a git repo') });
    await expect(getRepoSlug()).resolves.toBeUndefined();
  });

  it('memoizes the failure — second call does not re-run git', async () => {
    gitAnswers({ error: new Error('not a git repo') });
    await expect(getRepoSlug()).resolves.toBeUndefined();
    execFile.mockClear();
    await expect(getRepoSlug()).resolves.toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('returns undefined when there is no workspace root', async () => {
    const originalFolders = (require('vscode') as typeof import('vscode')).workspace.workspaceFolders;
    ((require('vscode') as any).workspace).workspaceFolders = undefined;
    try {
      await expect(getRepoSlug()).resolves.toBeUndefined();
      expect(execFile).not.toHaveBeenCalled();
    } finally {
      ((require('vscode') as any).workspace).workspaceFolders = originalFolders;
    }
  });
});

describe('getLocalTestIds', () => {
  beforeEach(() => {
    (myTestController.items as any)._items.clear();
  });

  it('returns empty array when no test items exist', () => {
    (myTestController.items.forEach as jest.Mock).mockImplementation(() => {});
    expect(getLocalTestIds()).toEqual([]);
  });

  it('collects test IDs and strips workspace root', () => {
    const mockChild1 = { id: '/mock/workspace/src/foo.test.ts#test1' };
    const mockChild2 = { id: '/mock/workspace/src/foo.test.ts#test2' };

    const mockFileItem = {
      id: '/mock/workspace/src/foo.test.ts',
      children: {
        forEach: jest.fn().mockImplementation((cb: any) => {
          cb(mockChild1);
          cb(mockChild2);
        }),
      },
    };

    (myTestController.items.forEach as jest.Mock).mockImplementation((cb: any) => {
      cb(mockFileItem, mockFileItem.id);
    });

    const ids = getLocalTestIds();
    expect(ids).toEqual(['/src/foo.test.ts#test1', '/src/foo.test.ts#test2']);
  });
});
