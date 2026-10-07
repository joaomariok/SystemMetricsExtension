const vscode = require('vscode');
const crypto = require('crypto');
const si = require('systeminformation');
const { startSources } = require('./metrics');

class MetricsViewProvider {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.stopSources = null;
  }

  resolveWebviewView(view) {
    const { webview } = view;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webview.html = this.html(webview);
    // The webview is usually recreated when the view is shown again and its script posts 'ready' on
    // every load; visibility also restarts sources in case the content survived. start() is idempotent.
    const sendSettings = () =>
      webview.postMessage({
        settings: { showCores: vscode.workspace.getConfiguration('systemMetrics').get('showCores', false) },
      });
    webview.onDidReceiveMessage((msg) => {
      if (msg !== 'ready') return;
      sendSettings();
      this.start(webview);
    });
    const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('systemMetrics.showCores')) sendSettings();
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) this.start(webview);
      else this.stop();
    });
    view.onDidDispose(() => {
      configListener.dispose();
      this.stop();
    });
  }

  start(webview) {
    if (this.stopSources) return;
    this.stopSources = startSources({ si, post: (snap) => webview.postMessage(snap) });
  }

  stop() {
    if (this.stopSources) this.stopSources();
    this.stopSources = null;
  }

  html(webview) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (file) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', file));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('view.css')}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${uri('format.js')}"></script>
<script nonce="${nonce}" src="${uri('view.js')}"></script>
</body>
</html>`;
  }
}

let provider;

function activate(context) {
  provider = new MetricsViewProvider(context.extensionUri);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('system-metrics.view', provider));
}

function deactivate() {
  if (provider) provider.stop();
}

module.exports = { activate, deactivate };
