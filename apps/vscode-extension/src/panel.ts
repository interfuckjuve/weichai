import * as vscode from 'vscode';
import type {
  HostToWebviewMessage,
  PanelInitPayload,
} from './protocol/messages';
import { isWebviewToHostMessage, type WebviewToHostMessage } from './protocol/messages';

/** Handlers invoked when the Webview posts a message to the host. */
export interface PanelHandlers {
  onMessage(message: WebviewToHostMessage): void;
}

const VIEW_TYPE = 'forexplore.translation';
const PANEL_TITLE = 'ForeXplore 代码翻译';

/**
 * Owns the translation Webview panel: creation, focus reuse, HTML injection
 * and postMessage delivery.
 */
export class TranslationPanel {
  public static current: TranslationPanel | undefined;

  private payload: PanelInitPayload;
  private handlers: PanelHandlers;

  private constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    payload: PanelInitPayload,
    handlers: PanelHandlers,
  ) {
    this.payload = payload;
    this.handlers = handlers;
  }

  static async createOrShow(
    context: vscode.ExtensionContext,
    payload: PanelInitPayload,
    handlers: PanelHandlers,
  ): Promise<TranslationPanel> {
    if (TranslationPanel.current) {
      TranslationPanel.current.payload = payload;
      TranslationPanel.current.handlers = handlers;
      TranslationPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      TranslationPanel.current.post({ type: 'INIT', payload });
      return TranslationPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      PANEL_TITLE,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
      },
    );

    const instance = new TranslationPanel(panel, context, payload, handlers);
    TranslationPanel.current = instance;
    // The Webview is not ready to receive messages until its scripts are
    // loaded, so hold the INIT payload until it announces itself with READY.
    panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!isWebviewToHostMessage(message)) return;
      if (message.type === 'READY') {
        instance.post({ type: 'INIT', payload: instance.payload });
        return;
      }
      instance.handlers.onMessage(message);
    });
    panel.onDidDispose(() => {
      if (TranslationPanel.current === instance) TranslationPanel.current = undefined;
    });
    panel.webview.html = await buildHtml(panel.webview, context.extensionUri);
    return instance;
  }

  post(message: HostToWebviewMessage): void {
    if (message.type === 'MODULE_EXPLORER') this.payload.moduleExplorer = message.explorer;
    if (message.type === 'CODE_INTELLIGENCE_STATUS') this.payload.codeIntelligence = message.presentation;
    if (message.type === 'SETTINGS_UPDATED') this.payload.settings = message.settings;
    if (message.type === 'TARGET_SELECTED') this.payload.target = message.target;
    if (message.type === 'TARGET_CLEARED') this.payload.target = null;
    void this.panel.webview.postMessage(message);
  }

  dispose(): void {
    this.panel.dispose();
  }
}

export async function buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<string> {
  const indexPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'index.html');
  const bytes = await vscode.workspace.fs.readFile(indexPath);
  let html = Buffer.from(bytes).toString('utf8');
  const assetRoot = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview'));
  html = html.replaceAll('src="./', `src="${assetRoot.toString()}/`).replaceAll('href="./', `href="${assetRoot.toString()}/`);
  html = html.replaceAll('{{CSP_SOURCE}}', webview.cspSource);
  return html;
}
