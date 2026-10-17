jest.mock('vscode', () => ({
  Uri: {
    joinPath: jest.fn((_base: unknown, ...parts: string[]) => ({ parts }))
  }
}), { virtual: true });

import * as vscode from 'vscode';
import { getDashboardHtml } from '../DashboardHtml';

describe('DashboardHtml', () => {
  it('generates a webview script that parses', () => {
    const webview = {
      asWebviewUri: (uri: vscode.Uri) => uri,
      cspSource: 'vscode-webview'
    } as unknown as vscode.Webview;
    const html = getDashboardHtml(webview, {} as vscode.Uri);
    const match = html.match(/<script>([\s\S]*?)<\/script>/);

    expect(match).not.toBeNull();
    expect(() => new Function(match![1])).not.toThrow();
  });
});
