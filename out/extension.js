"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const os = require("os");
const cp = require("child_process");
class ExrPreviewDocument {
    static async create(uri, backupId) {
        return new ExrPreviewDocument(uri);
    }
    constructor(uri) {
        this.uri = uri;
    }
    dispose() { }
}
class ExrPreviewEditorProvider {
    static register(context) {
        return vscode.window.registerCustomEditorProvider('exr-preview.exrPreview', new ExrPreviewEditorProvider(context), {
            supportsMultipleEditorsPerDocument: false,
        });
    }
    constructor(context) {
        this.context = context;
        this.onDidChangeCustomDocument = new vscode.EventEmitter().event;
    }
    async resolveCustomEditor(document, webviewPanel, _token) {
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri]
        };
        const tempDir = os.tmpdir();
        const previewPath = path.join(tempDir, `preview_${path.basename(document.uri.fsPath)}.png`);
        try {
            // Generate preview using oiiotool
            await new Promise((resolve, reject) => {
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
        }
        catch (error) {
            vscode.window.showErrorMessage(`Failed to generate EXR preview: ${error}`);
        }
    }
    getHtmlForWebview(imageData) {
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
    async openCustomDocument(uri, openContext, _token) {
        return await ExrPreviewDocument.create(uri, openContext.backupId);
    }
    async saveCustomDocument(document, cancellation) {
        // Read-only preview, no save needed
    }
    async saveCustomDocumentAs(document, destination, cancellation) {
        // Read-only preview, no save needed
    }
    async revertCustomDocument(document, cancellation) {
        // Read-only preview, no revert needed
    }
    async backupCustomDocument(document, context, cancellation) {
        return {
            id: context.destination.toString(),
            delete: async () => { }
        };
    }
}
function activate(context) {
    context.subscriptions.push(ExrPreviewEditorProvider.register(context));
}
function deactivate() { }
//# sourceMappingURL=extension.js.map