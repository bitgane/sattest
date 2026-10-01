import * as vscode from 'vscode';

export interface CustomTestItem {
  id: string;
  label: string;
  uri?: vscode.Uri;
  range?: vscode.Range; // ← this is settable!
  realTestItem?: vscode.TestItem; // optional: link to real item if found
  children: CustomTestItem[];
}

export class TestItemWrapper implements CustomTestItem {
  public id: string;
  public label: string;
  public uri?: vscode.Uri;
  public range?: vscode.Range;
  public realTestItem?: vscode.TestItem;
  public children: CustomTestItem[] = [];

  constructor(
    id: string,
    label: string,
    uri?: vscode.Uri,
    range?: vscode.Range,
    realTestItem?: vscode.TestItem
  ) {
    this.id = id;
    this.label = label;
    this.uri = uri;
    this.range = range;
    this.realTestItem = realTestItem;
  }

  // Helper to add child
  addChild(child: CustomTestItem) {
    this.children.push(child);
  }
}
