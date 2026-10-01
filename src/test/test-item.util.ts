import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { myTestController } from './test-controller.js'; // adjust path to your controller import
import { CustomTestItem, TestItemWrapper } from './test-item-wrapper.js';

let cachedRepoSlug: string | undefined;

export function getRepoSlug(): string | undefined {
  if (cachedRepoSlug !== undefined) {
    return cachedRepoSlug || undefined;
  }

  try {
    const root = workspaceRoot();
    if (!root) {
      cachedRepoSlug = '';
      return undefined;
    }

    const remoteUrl = execSync('git remote get-url origin', {
      cwd: root,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    cachedRepoSlug = parseRepoSlug(remoteUrl);
    return cachedRepoSlug || undefined;
  } catch {
    cachedRepoSlug = '';
    return undefined;
  }
}

export function parseRepoSlug(remoteUrl: string): string {
  // SSH: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/[:\/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return sshMatch[1];
  }
  return '';
}

export function getLocalTestIds(): string[] {
  const ids: string[] = [];
  const rootPath = workspaceRoot();

  myTestController.items.forEach((fileItem) => {
    fileItem.children.forEach((testItem) => {
      let id = testItem.id;
      if (rootPath && id.startsWith(rootPath)) {
        id = id.slice(rootPath.length);
      }
      ids.push(id);
    });
  });

  return ids;
}

/**
 * Flat `id → TestItem` index of the controller's whole tree, built in one pass.
 *
 * Callers that resolve more than one id (the code-lens render, the startup
 * bounty attach) build this once and pass it to `findTestItemById`, turning what
 * used to be a full tree walk *per bounty* into one walk plus O(1) lookups.
 *
 * Ids are unique by construction — a file item is keyed by its fsPath and a test
 * item by `<fsPath>#<test name>` — so first-write-wins can never discard a
 * different item than the old depth-first search would have returned.
 */
export function buildTestItemIndex(): Map<string, vscode.TestItem> {
  const index = new Map<string, vscode.TestItem>();

  const visit = (collection: vscode.TestItemCollection): void => {
    collection.forEach((item) => {
      const key = item.id.trim();
      if (!index.has(key)) {
        index.set(key, item);
      }
      visit(item.children);
    });
  };

  visit(myTestController.items);
  return index;
}

/**
 * Resolves a TestItem by ID and wraps it so callers get a stable
 * `CustomTestItem` (the wrapper keeps the *original* backend id, which may carry
 * a `#…` fragment the real item doesn't).
 *
 * Pass `index` when resolving several ids against the same tree — see
 * `buildTestItemIndex`. Omitting it builds a throwaway index for this one
 * lookup, which is what a single-shot caller wants.
 *
 * Note the previous implementation walked the tree with `collection.forEach` and
 * a `return` it documented as an "early exit". `TestItemCollection.forEach` has
 * no early exit, so that walk always traversed every item in the tree even after
 * matching — the index replaces it outright.
 */
export function findTestItemById(
  id: string,
  index?: Map<string, vscode.TestItem>
): CustomTestItem {
  const realItem = (index ?? buildTestItemIndex()).get(id.trim());

  if (realItem) {
    // Create wrapper with original ID and real range (if any)
    const wrapper = new TestItemWrapper(
      id, // ← original backend ID (with #add if present)
      realItem.label,
      realItem.uri,
      realItem.range, // ← real range if VS Code set it
      realItem
    );

    // Copy children recursively (optional)
    realItem.children.forEach((child) => {
      wrapper.addChild(new TestItemWrapper(child.id, child.label, child.uri, child.range, child));
    });

    return wrapper;
  }
  // Fallback: create dummy wrapper if not found
  console.warn('[findTestItemById] No real TestItem found – creating dummy');
  return new TestItemWrapper(
    id,
    'Unknown Test',
    undefined,
    new vscode.Range(0, 0, 0, 0) // dummy fallback range
  );
}

/**
 * The workspace file path a bounty's testId refers to.
 *
 * Test ids are `<fsPath>#<test name>` (see `normalizedTestId`), so the portion
 * before the `#` names the file. Returns '' when the id carries no usable path,
 * which callers must treat as "unknown — don't skip it".
 */
export function testIdFilePath(testId: string): string {
  const hashIndex = testId.indexOf('#');
  return hashIndex === -1 ? testId : testId.slice(0, hashIndex);
}

export const workspaceRoot = () => {
  if (!vscode.workspace) {
    console.warn(
      '[workspaceRoot] No vscode.workspace – returning empty string (likely in test env)'
    );
    return '';
  }

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (!root) {
    console.error('[Extension] No workspace folder open');
    return '';
  }

  return root;
};

export const removeParentLabelFromTestId = (test: vscode.TestItem): string => {
  const testId = test.id;
  if (!test.parent || !test.parent.id) {
    return testId;
  }
  const parentId = test.parent.id;

  const hashIndex = testId.indexOf('#');
  if (hashIndex === -1) {
    return testId;
  }

  const filePath = parentId.slice(0, hashIndex);
  const prefix = parentId.slice(hashIndex + 1);

  const parentHashIndex = parentId.indexOf('#');
  if (parentHashIndex === -1) {
    return testId;
  }

  const baseFragment = testId.slice(parentHashIndex + 1);

  if (baseFragment.startsWith(prefix)) {
    return `${filePath}#${baseFragment.slice(prefix.length + 1)}`;
  }
  return parentId;
};

export const relativeTestPath = (test: vscode.TestItem) => {
  const rootPath = workspaceRoot() || '';
  const relativeTestPath = test.uri?.fsPath.replace(rootPath, '') || 'unknown/test-file.test.ts';
  return relativeTestPath;
};

export const normalizedTestPath = (test: vscode.TestItem) => {
  const relativePath = relativeTestPath(test) || '';
  const normalizedPath = relativePath.startsWith('/') ? relativePath : '/' + relativePath;
  return normalizedPath;
};

export const normalizedTestId = (test: vscode.TestItem) => {
  let testId = test.id.trim();

  let testName = '';
  const rootPath = workspaceRoot();

  if (rootPath && !testId.startsWith(rootPath)) {
    return testId;
  }
  // Compute relative path from workspace root
  let normTestPath = normalizedTestPath(test);
  if (!rootPath || !test.uri?.fsPath) {
    console.warn('[addBounty] No workspace root or file URI – using fallback testId:', test.id);
    testId = test.id || 'unknown-test';
  } else {
    // Append the # and test name part from test.id
    const hashIndex = test.id.indexOf('#');
    if (hashIndex !== -1) {
      testName = test.id.substring(hashIndex);
      testId = normTestPath += testName;
    }
  }
  return testId;
};
