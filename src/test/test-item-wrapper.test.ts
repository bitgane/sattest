import * as vscode from 'vscode';
import { TestItemWrapper } from './test-item-wrapper.js';

describe('TestItemWrapper', () => {
  it('creates wrapper with all properties', () => {
    const uri = vscode.Uri.file('/path/to/test.ts');
    const range = new vscode.Range(5, 0, 5, 10);
    const realItem = { id: 'real', label: 'real' } as vscode.TestItem;

    const wrapper = new TestItemWrapper('test-id', 'test label', uri, range, realItem);

    expect(wrapper.id).toBe('test-id');
    expect(wrapper.label).toBe('test label');
    expect(wrapper.uri).toBe(uri);
    expect(wrapper.range).toBe(range);
    expect(wrapper.realTestItem).toBe(realItem);
    expect(wrapper.children).toEqual([]);
  });

  it('creates wrapper without optional properties', () => {
    const wrapper = new TestItemWrapper('test-id', 'test label');

    expect(wrapper.id).toBe('test-id');
    expect(wrapper.label).toBe('test label');
    expect(wrapper.uri).toBeUndefined();
    expect(wrapper.range).toBeUndefined();
    expect(wrapper.realTestItem).toBeUndefined();
  });

  it('addChild appends to children array', () => {
    const parent = new TestItemWrapper('parent', 'Parent Test');
    const child1 = new TestItemWrapper('child1', 'Child 1');
    const child2 = new TestItemWrapper('child2', 'Child 2');

    parent.addChild(child1);
    parent.addChild(child2);

    expect(parent.children).toHaveLength(2);
    expect(parent.children[0].id).toBe('child1');
    expect(parent.children[1].id).toBe('child2');
  });
});
