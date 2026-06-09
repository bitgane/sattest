import * as vscode from 'vscode';
import { ALL_FILE_GLOBS, SUPPORTED_LANGUAGE_IDS, findTestsInContent } from './language-configs.js';

export const myTestController = vscode.tests.createTestController(
  'bountyTestController',
  'Bounty Tests'
);

/**
 * Discovers test files across all supported languages and registers them
 * with the test controller.
 */
export function registerTests() {
  // Clear existing items
  myTestController.items.replace([]);

  // Fire all glob queries in parallel, then process results
  Promise.all(ALL_FILE_GLOBS.map((glob) => vscode.workspace.findFiles(glob))).then((fileArrays) => {
    // Deduplicate (a file might match multiple globs)
    const seen = new Set<string>();
    const uniqueFiles: vscode.Uri[] = [];
    for (const files of fileArrays) {
      for (const file of files) {
        if (!seen.has(file.fsPath)) {
          seen.add(file.fsPath);
          uniqueFiles.push(file);
        }
      }
    }

    uniqueFiles.forEach(async (file) => {
      try {
        const bytes = await vscode.workspace.fs.readFile(file);
        const content = new TextDecoder().decode(bytes);

        const testMatches = findTestsInContent(content, file.fsPath);
        if (testMatches.length === 0) {
          return;
        }

        // Create root test-file item
        const testFile = myTestController.createTestItem(
          file.fsPath,
          file.fsPath.split('/').pop() || 'Test File',
          file
        );

        for (const tm of testMatches) {
          const testItem = myTestController.createTestItem(
            `${file.fsPath}#${tm.name}`,
            tm.name,
            file
          );
          testItem.range = new vscode.Range(tm.lineNumber, 0, tm.lineNumber, tm.lineLength);
          testFile.children.add(testItem);
        }

        myTestController.items.add(testFile);
      } catch (err) {
        // Skip files that cannot be read
      }
    });
  });
}

// Run discovery on activation
export function activateTestController(context: vscode.ExtensionContext) {
  registerTests();

  // Re-discover when a supported file is opened
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (SUPPORTED_LANGUAGE_IDS.includes(doc.languageId)) {
        registerTests();
      }
    })
  );
}
