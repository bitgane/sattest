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
 * Recursively searches the Test Controller's items for a TestItem with the given ID.
 * Returns the first matching item or undefined if not found.
 */
export function findTestItemById(id: string): CustomTestItem {
  function search(collection: vscode.TestItemCollection): vscode.TestItem | undefined {
    let found: vscode.TestItem | undefined = undefined;

    collection.forEach((item) => {
      if (id.trim() === item.id.trim()) {
        found = item;
        return; // early exit
      }

      const childFound = search(item.children);
      if (childFound) {
        found = childFound;
        return;
      }
    });
    return found;
  }
  const realItem = search(myTestController.items);

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
