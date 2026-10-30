import * as vscode from 'vscode';
import { ALL_FILE_GLOBS, findTestsInContent } from './language-configs.js';

export const myTestController = vscode.tests.createTestController(
  'bountyTestController',
  'Bounty Tests'
);

/** The files the workspace scan reads, as a selector for documents opened later. */
const TEST_FILE_SELECTOR: vscode.DocumentFilter[] = ALL_FILE_GLOBS.map((pattern) => ({
  scheme: 'file',
  pattern,
}));

/**
 * Replace one file's tests in the tree with the ones `content` declares, or
 * drop the file when it declares none.
 *
 * The file's item is swapped in a single `add` (same id, so it replaces the
 * old one): anything reading the tree mid-update — the CodeLens provider in
 * particular — sees the old tests or the new ones, never an empty tree.
 */
export function updateTestsInFile(file: vscode.Uri, content: string): void {
  const testMatches = findTestsInContent(content, file.fsPath);
  if (testMatches.length === 0) {
    myTestController.items.delete(file.fsPath);
    return;
  }

  // Create root test-file item
  const testFile = myTestController.createTestItem(
    file.fsPath,
    file.fsPath.split('/').pop() || 'Test File',
    file
  );

  for (const tm of testMatches) {
    const testItem = myTestController.createTestItem(`${file.fsPath}#${tm.name}`, tm.name, file);
    testItem.range = new vscode.Range(tm.lineNumber, 0, tm.lineNumber, tm.lineLength);
    testFile.children.add(testItem);
  }

  myTestController.items.add(testFile);
}

/** Re-read one file from disk and update its tests. */
async function updateTestsFromDisk(file: vscode.Uri): Promise<void> {
  try {
    const bytes = await vscode.workspace.fs.readFile(file);
    updateTestsInFile(file, new TextDecoder().decode(bytes));
  } catch (err) {
    // Skip files that cannot be read
  }
}

/**
 * Discovers test files across all supported languages and registers them
 * with the test controller.
 *
 * Never clears the tree: each file is added or replaced as it's read, and only
 * files the scan no longer finds are pruned, once it has finished.
 */
export async function registerTests(): Promise<void> {
  // Fire all glob queries in parallel, then process results
  const fileArrays = await Promise.all(
    ALL_FILE_GLOBS.map((glob) => vscode.workspace.findFiles(glob))
  );

  // Deduplicate (a file might match multiple globs)
  const uniqueFiles = new Map<string, vscode.Uri>();
  for (const files of fileArrays) {
    for (const file of files) {
      if (!uniqueFiles.has(file.fsPath)) {
        uniqueFiles.set(file.fsPath, file);
      }
    }
  }

  await Promise.all([...uniqueFiles.values()].map(updateTestsFromDisk));

  const gone: string[] = [];
  myTestController.items.forEach((fileItem) => {
    if (!uniqueFiles.has(fileItem.id)) {
      gone.push(fileItem.id);
    }
  });
  gone.forEach((id) => myTestController.items.delete(id));
}

// Run discovery on activation
export function activateTestController(context: vscode.ExtensionContext) {
  // Dispose the controller (and all its discovered test items) on unload.
  context.subscriptions.push(myTestController);

  void registerTests();

  // After the first scan, keep the tree current one file at a time. Opening a
  // supported file used to rerun the whole scan, clearing the tree first, so
  // the tree (and every CodeLens resolved through it) went empty while every
  // test file in the workspace was re-read.
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (vscode.languages.match(TEST_FILE_SELECTOR, doc) > 0) {
        updateTestsInFile(doc.uri, doc.getText());
      }
    })
  );

  // Created, saved and deleted test files, including changes made outside the
  // editor (a branch switch, a pull).
  for (const glob of ALL_FILE_GLOBS) {
    const watcher = vscode.workspace.createFileSystemWatcher(glob);
    context.subscriptions.push(
      watcher,
      watcher.onDidCreate(updateTestsFromDisk),
      watcher.onDidChange(updateTestsFromDisk),
      watcher.onDidDelete((file) => myTestController.items.delete(file.fsPath))
    );
  }
}
