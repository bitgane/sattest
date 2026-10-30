import * as vscode from 'vscode';
import {
  myTestController,
  registerTests,
  activateTestController,
  updateTestsInFile,
} from './test-controller.js';
import { ALL_FILE_GLOBS } from './language-configs.js';

/** Let pending promise chains (a scan, a file read) run to completion. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Put a file item in the tree, as an earlier scan would have. */
function addFileItem(uri: vscode.Uri) {
  myTestController.items.add(
    myTestController.createTestItem(uri.fsPath, uri.fsPath.split('/').pop()!, uri)
  );
}

describe('test-controller', () => {
  beforeEach(() => {
    // Empty the tree without going through `replace`, which the tests below
    // assert is never called.
    (myTestController.items as any)._items.clear();
  });

  it('creates the test controller', () => {
    expect(myTestController).toBeDefined();
    expect(myTestController.items).toBeDefined();
    expect(myTestController.createTestItem).toBeDefined();
  });

  describe('registerTests', () => {
    it('never clears the tree while rescanning', async () => {
      const fooUri = vscode.Uri.file('/mock/workspace/src/foo.test.ts');
      addFileItem(fooUri);
      (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([fooUri]);
      let finishRead!: () => void;
      (vscode.workspace.fs.readFile as jest.Mock).mockReturnValue(
        new Promise((resolve) => {
          finishRead = () => resolve(Buffer.from(`test('a test', () => {});`));
        })
      );

      const scan = registerTests();
      await settle();

      // Mid-scan, while the file is still being read, its tests are still there.
      expect(myTestController.items.get(fooUri.fsPath)).toBeDefined();
      expect(myTestController.items.replace).not.toHaveBeenCalled();

      finishRead();
      await scan;
      expect(myTestController.items.get(fooUri.fsPath)?.children.size).toBe(1);
    });

    it('drops files the scan no longer finds, once it has finished', async () => {
      const keptUri = vscode.Uri.file('/mock/workspace/src/kept.test.ts');
      const goneUri = vscode.Uri.file('/mock/workspace/src/gone.test.ts');
      addFileItem(goneUri);
      (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([keptUri]);
      (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(
        Buffer.from(`test('a test', () => {});`)
      );

      await registerTests();

      expect(myTestController.items.get(keptUri.fsPath)).toBeDefined();
      expect(myTestController.items.get(goneUri.fsPath)).toBeUndefined();
    });

    it('calls findFiles for each glob pattern', () => {
      registerTests();
      expect(vscode.workspace.findFiles).toHaveBeenCalledTimes(ALL_FILE_GLOBS.length);
      for (const glob of ALL_FILE_GLOBS) {
        expect(vscode.workspace.findFiles).toHaveBeenCalledWith(glob);
      }
    });

    it('creates test items from TypeScript file contents', async () => {
      const mockUri = vscode.Uri.file('/mock/workspace/src/foo.test.ts');
      (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([mockUri]);
      (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(
        Buffer.from(`
describe('my suite', () => {
  it('should do something', () => {});
  test('another test', () => {});
});
`)
      );

      registerTests();

      // Wait for async file processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(myTestController.createTestItem).toHaveBeenCalled();
    });

    it('creates test items from Java file contents', async () => {
      const mockUri = vscode.Uri.file('/mock/workspace/src/FooTest.java');
      (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([mockUri]);
      (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(
        Buffer.from(`
import org.junit.jupiter.api.Test;
public class FooTest {
    @Test
    public void shouldDoSomething() {
        assertEquals(1, 1);
    }
}
`)
      );

      registerTests();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(myTestController.createTestItem).toHaveBeenCalled();
    });

    it('creates test items from Python file contents', async () => {
      const mockUri = vscode.Uri.file('/mock/workspace/test_foo.py');
      (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([mockUri]);
      (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(
        Buffer.from(`
def test_addition():
    assert 1 + 1 == 2

class TestMath:
    def test_subtract(self):
        assert 2 - 1 == 1
`)
      );

      registerTests();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(myTestController.createTestItem).toHaveBeenCalled();
    });

    it('creates test items from Go file contents', async () => {
      const mockUri = vscode.Uri.file('/mock/workspace/foo_test.go');
      (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([mockUri]);
      (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(
        Buffer.from(`
package foo

import "testing"

func TestAdd(t *testing.T) {
    if 1+1 != 2 {
        t.Error("expected 2")
    }
}
`)
      );

      registerTests();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(myTestController.createTestItem).toHaveBeenCalled();
    });

    it('deduplicates files matching multiple globs', async () => {
      const mockUri = vscode.Uri.file('/mock/workspace/src/foo.test.ts');
      // Return same file from multiple glob matches
      (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([mockUri]);
      (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(
        Buffer.from(`test('a test', () => {});`)
      );

      registerTests();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // readFile should only be called once per unique file, not once per glob hit
      expect(vscode.workspace.fs.readFile).toHaveBeenCalledTimes(1);
    });

    it('handles errors reading files gracefully', async () => {
      const mockUri = vscode.Uri.file('/mock/workspace/src/bad.test.ts');
      (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([mockUri]);
      (vscode.workspace.fs.readFile as jest.Mock).mockRejectedValue(new Error('File not found'));

      registerTests();

      // Wait for async processing - should not throw
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    it('skips files with no test matches', async () => {
      const mockUri = vscode.Uri.file('/mock/workspace/src/empty.test.ts');
      (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([mockUri]);
      (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(
        Buffer.from('// no tests here\nconst x = 1;\n')
      );

      registerTests();

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The file item shouldn't be added to controller (no tests found)
      expect(myTestController.items.get(mockUri.fsPath)).toBeUndefined();
    });
  });

  describe('updateTestsInFile', () => {
    it("replaces a file's tests with the ones its content declares", () => {
      const uri = vscode.Uri.file('/mock/workspace/src/foo.test.ts');
      updateTestsInFile(uri, `it('one', () => {});`);
      updateTestsInFile(uri, `it('one', () => {});\nit('two', () => {});`);

      const fileItem = myTestController.items.get(uri.fsPath)!;
      expect(fileItem.children.size).toBe(2);
      expect(myTestController.items.size).toBe(1);
    });

    it('drops a file that no longer declares any tests', () => {
      const uri = vscode.Uri.file('/mock/workspace/src/foo.test.ts');
      updateTestsInFile(uri, `it('one', () => {});`);
      updateTestsInFile(uri, '// every test deleted');

      expect(myTestController.items.get(uri.fsPath)).toBeUndefined();
    });
  });

  describe('activateTestController', () => {
    function activateWith(mockContext = { subscriptions: [] as any[] }) {
      activateTestController(mockContext as unknown as vscode.ExtensionContext);
      return mockContext;
    }

    beforeEach(() => {
      (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([]);
    });

    it('scans the workspace on activation', () => {
      activateWith();
      expect(vscode.workspace.findFiles).toHaveBeenCalledTimes(ALL_FILE_GLOBS.length);
    });

    it('registers onDidOpenTextDocument listener', () => {
      const mockContext = activateWith();

      expect(vscode.workspace.onDidOpenTextDocument).toHaveBeenCalled();
      expect(mockContext.subscriptions.length).toBeGreaterThan(0);
    });

    it('opening a test file updates just that file, from its open text', async () => {
      let onOpen!: (doc: unknown) => void;
      (vscode.workspace.onDidOpenTextDocument as jest.Mock).mockImplementationOnce((listener) => {
        onOpen = listener;
        return { dispose: jest.fn() };
      });
      activateWith();
      await settle(); // let the activation scan finish

      const otherUri = vscode.Uri.file('/mock/workspace/src/other.test.ts');
      const openedUri = vscode.Uri.file('/mock/workspace/src/opened.test.ts');
      addFileItem(otherUri);
      (vscode.workspace.findFiles as jest.Mock).mockClear();
      (vscode.languages.match as jest.Mock).mockReturnValueOnce(10);

      onOpen({ uri: openedUri, getText: () => `it('opens', () => {});` });

      expect(myTestController.items.get(openedUri.fsPath)?.children.size).toBe(1);
      // The rest of the tree is untouched, and nothing was rescanned or re-read.
      expect(myTestController.items.get(otherUri.fsPath)).toBeDefined();
      expect(myTestController.items.replace).not.toHaveBeenCalled();
      expect(vscode.workspace.findFiles).not.toHaveBeenCalled();
      expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
    });

    it("ignores opened documents that aren't test files", async () => {
      let onOpen!: (doc: unknown) => void;
      (vscode.workspace.onDidOpenTextDocument as jest.Mock).mockImplementationOnce((listener) => {
        onOpen = listener;
        return { dispose: jest.fn() };
      });
      activateWith();
      await settle();
      (vscode.languages.match as jest.Mock).mockReturnValueOnce(0);

      const utilUri = vscode.Uri.file('/mock/workspace/src/util.ts');
      onOpen({ uri: utilUri, getText: () => `it('looks like a test', () => {});` });

      expect(myTestController.items.get(utilUri.fsPath)).toBeUndefined();
    });

    it('keeps the tree current from file-system events', async () => {
      const watchers: Array<{ on: Record<string, (uri: vscode.Uri) => unknown> }> = [];
      (vscode.workspace.createFileSystemWatcher as jest.Mock).mockImplementation(() => {
        const on: Record<string, (uri: vscode.Uri) => unknown> = {};
        const listen = (event: string) =>
          jest.fn((listener: (uri: vscode.Uri) => unknown) => {
            on[event] = listener;
            return { dispose: jest.fn() };
          });
        watchers.push({ on });
        return {
          onDidCreate: listen('create'),
          onDidChange: listen('change'),
          onDidDelete: listen('delete'),
          dispose: jest.fn(),
        };
      });
      activateWith();
      await settle();

      expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(ALL_FILE_GLOBS.length);
      const { on } = watchers[0];
      const uri = vscode.Uri.file('/mock/workspace/src/new.test.ts');

      (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValueOnce(
        Buffer.from(`it('new', () => {});`)
      );
      await on.create(uri);
      expect(myTestController.items.get(uri.fsPath)?.children.size).toBe(1);

      (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValueOnce(
        Buffer.from(`it('one', () => {});\nit('two', () => {});`)
      );
      await on.change(uri);
      expect(myTestController.items.get(uri.fsPath)?.children.size).toBe(2);

      on.delete(uri);
      expect(myTestController.items.get(uri.fsPath)).toBeUndefined();
    });
  });
});
