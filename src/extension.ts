import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as cp from 'child_process';

class ExrPreviewDocument implements vscode.CustomDocument {
    static async create(
        uri: vscode.Uri,
        backupId: string | undefined
    ): Promise<ExrPreviewDocument | PromiseLike<ExrPreviewDocument>> {
        return new ExrPreviewDocument(uri);
    }

    private constructor(public readonly uri: vscode.Uri) {}

    dispose(): void {}
}

class ExrPreviewEditorProvider implements vscode.CustomEditorProvider<ExrPreviewDocument> {
    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        return vscode.window.registerCustomEditorProvider(
            'exr-preview.exrPreview',
            new ExrPreviewEditorProvider(context),
            {
                supportsMultipleEditorsPerDocument: false,
            }
        );
    }

    constructor(private readonly context: vscode.ExtensionContext) {}

    onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<ExrPreviewDocument>>().event;

    async resolveCustomEditor(
        document: ExrPreviewDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri]
        };

        const tempDir = os.tmpdir();
        const previewPath = path.join(tempDir, `preview_${path.basename(document.uri.fsPath)}.png`);

        try {
            // Generate preview using oiiotool
            await new Promise<void>((resolve, reject) => {
                cp.exec(`oiiotool "${document.uri.fsPath}" -o "${previewPath}"`, (error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });

            // Read the preview image and convert to base64
            const imageData = fs.readFileSync(previewPath);
            const base64Image = imageData.toString('base64');

            // Update webview content
            webviewPanel.webview.html = this.getHtmlForWebview(base64Image);

            // Clean up the temporary preview file
            fs.unlinkSync(previewPath);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to generate EXR preview: ${error}`);
        }
    }

    private getHtmlForWebview(imageData: string): string {
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body {
                        margin: 0;
                        padding: 0;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        min-height: 100vh;
                        background-color: var(--vscode-editor-background);
                    }
                    img {
                        max-width: 100%;
                        max-height: 100vh;
                        object-fit: contain;
                    }
                </style>
            </head>
            <body>
                <img src="data:image/png;base64,${imageData}" />
            </body>
            </html>
        `;
    }

    async openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): Promise<ExrPreviewDocument> {
        return await ExrPreviewDocument.create(uri, openContext.backupId);
    }

    async saveCustomDocument(document: ExrPreviewDocument, cancellation: vscode.CancellationToken): Promise<void> {
        // Read-only preview, no save needed
    }

    async saveCustomDocumentAs(document: ExrPreviewDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
        // Read-only preview, no save needed
    }

    async revertCustomDocument(document: ExrPreviewDocument, cancellation: vscode.CancellationToken): Promise<void> {
        // Read-only preview, no revert needed
    }

    async backupCustomDocument(document: ExrPreviewDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
        return {
            id: context.destination.toString(),
            delete: async () => {}
        };
    }
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(ExrPreviewEditorProvider.register(context));
}

export function deactivate() {} 