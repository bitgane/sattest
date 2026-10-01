import * as vscode from 'vscode';
import { myTestController, registerTests, activateTestController } from './test-controller.js';
import { ALL_FILE_GLOBS, SUPPORTED_LANGUAGE_IDS } from './language-configs.js';

describe('test-controller', () => {
  beforeEach(() => {
    myTestController.items.replace([]);
  });

  it('creates the test controller', () => {
    expect(myTestController).toBeDefined();
    expect(myTestController.items).toBeDefined();
    expect(myTestController.createTestItem).toBeDefined();
  });

  describe('registerTests', () => {
    it('clears existing items', () => {
      registerTests();
      expect(myTestController.items.replace).toHaveBeenCalledWith([]);
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
    });
  });

  describe('activateTestController', () => {
    it('calls registerTests on activation', () => {
      const mockContext = {
        subscriptions: [] as any[],
      } as unknown as vscode.ExtensionContext;

      activateTestController(mockContext);

      expect(myTestController.items.replace).toHaveBeenCalledWith([]);
      expect(vscode.workspace.findFiles).toHaveBeenCalled();
    });

    it('registers onDidOpenTextDocument listener', () => {
      const mockContext = {
        subscriptions: [] as any[],
      } as unknown as vscode.ExtensionContext;

      activateTestController(mockContext);

      expect(vscode.workspace.onDidOpenTextDocument).toHaveBeenCalled();
      expect(mockContext.subscriptions.length).toBeGreaterThan(0);
    });
  });
});
