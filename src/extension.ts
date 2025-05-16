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
        async function runCommand(cmd: string) {
            await new Promise<void>((resolve, reject) => {
                cp.exec(cmd, (error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        }

        try {
            const ext = path.extname(document.uri.fsPath).toLowerCase();
            if (ext === '.exr') {
                const cmd = `oiiotool "${document.uri.fsPath}" -o "${previewPath}"`;
                await runCommand(cmd);
                const imageData = fs.readFileSync(previewPath);
                const base64Image = imageData.toString('base64');
                webviewPanel.webview.html = this.getHtmlForWebview(base64Image);
                fs.unlinkSync(previewPath);
                return;
            } else if (ext === '.ktx2') {
                // Get info JSON
                const infoJson = await new Promise<string>((resolve, reject) => {
                    cp.exec(`ktx info --format json "${document.uri.fsPath}"`, (error, stdout) => {
                        if (error) reject(error);
                        else resolve(stdout);
                    });
                });
                const info = JSON.parse(infoJson);
                // Initial preview: level 0, layer 0, face 0, depth 0
                const selection = { level: 0, layer: 0, face: 0, depth: 0 };
                await this.updateKtx2Preview(document.uri.fsPath, previewPath, selection, info);
                const imageData = fs.readFileSync(previewPath);
                const base64Image = imageData.toString('base64');
                const levelInfoHtml = this.renderLevelInfo(info.header, info.index, selection.level);
                webviewPanel.webview.html = this.getHtmlForKtx2Webview(base64Image, info, selection);
                fs.unlinkSync(previewPath);
                // Listen for selection changes
                webviewPanel.webview.onDidReceiveMessage(async (msg) => {
                    if (msg.type === 'extract') {
                        try {
                            await this.updateKtx2Preview(document.uri.fsPath, previewPath, msg.selection, info);
                            const imageData = fs.readFileSync(previewPath);
                            const base64Image = imageData.toString('base64');
                            const levelInfoHtml = this.renderLevelInfo(info.header, info.index, msg.selection.level);
                            webviewPanel.webview.postMessage({ type: 'updateImage', base64Image, levelInfoHtml });
                            fs.unlinkSync(previewPath);
                        } catch (e) {
                            vscode.window.showErrorMessage(`Failed to extract KTX2 part: ${e}`);
                        }
                    }
                });
                return;
            } else {
                throw new Error('Unsupported file type');
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to generate preview: ${error}`);
        }
    }

    private async updateKtx2Preview(
        ktx2Path: string,
        previewPath: string,
        selection: { level: number, layer: number, face: number, depth: number },
        info?: any
    ) {
        const header = info?.header || {};
        let cmd = `ktx extract --level ${selection.level}`;
        if ((header.layerCount || 0) > 1) cmd += ` --layer ${selection.layer}`;
        if ((header.faceCount || 0) > 1) cmd += ` --face ${selection.face}`;
        if ((header.pixelDepth || 0) > 1) cmd += ` --depth ${selection.depth}`;
        cmd += ` "${ktx2Path}" "${previewPath}"`;
        await new Promise<void>((resolve, reject) => {
            cp.exec(cmd, (error) => {
                if (error) reject(error);
                else resolve();
            });
        });
        // Optionally clean up PNG with oiiotool if needed
        cmd = `oiiotool "${previewPath}" -o "${previewPath}"`;
        await new Promise<void>((resolve, reject) => {
            cp.exec(cmd, (error) => {
                if (error) reject(error);
                else resolve();
            });
        });
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

    private getHtmlForKtx2Webview(imageData: string, info: any, selection: { level: number, layer: number, face: number, depth: number }): string {
        // Extract header info for buttons
        const header = info.header || {};
        const levelCount = header.levelCount || 1;
        const layerCount = header.layerCount || 1;
        const faceCount = header.faceCount || 1;
        const depthCount = header.pixelDepth || 1;
        // Render info as a themed table
        function renderInfoTable(obj: any): string {
            return `<table style="width:100%;color:var(--vscode-foreground);background:var(--vscode-editor-background);border-collapse:collapse;">
                ${Object.entries(obj).map(([k, v]) => `<tr><td style="font-weight:bold;padding:2px 8px;">${k}</td><td style="padding:2px 8px;">${typeof v === 'object' ? JSON.stringify(v) : v}</td></tr>`).join('')}
            </table>`;
        }
        // Render mip level info
        function renderLevelInfo(index: any, level: number): string {
            if (!index || !index.levels || !index.levels[level]) return '';
            const lvl = index.levels[level];
            let res = '';
            if (header.pixelWidth && header.pixelHeight && header.levelCount) {
                // Calculate mip resolution
                const w = Math.max(1, header.pixelWidth >> level);
                const h = Math.max(1, header.pixelHeight >> level);
                res = `<tr><td style='font-weight:bold;padding:2px 8px;'>Resolution</td><td style='padding:2px 8px;'>${w} × ${h}</td></tr>`;
            }
            return `<table style='width:100%;margin-top:8px;color:var(--vscode-foreground);background:var(--vscode-editor-background);border-collapse:collapse;'>
                <tr><td colspan=2 style='font-weight:bold;padding:2px 8px;'>Selected Mip Level: ${level}</td></tr>
                ${res}
                ${Object.entries(lvl).map(([k, v]) => `<tr><td style='font-weight:bold;padding:2px 8px;'>${k}</td><td style='padding:2px 8px;'>${v}</td></tr>`).join('')}
            </table>`;
        }
        return /*html*/`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body {
                        margin: 0;
                        padding: 0;
                        background-color: var(--vscode-editor-background);
                        color: var(--vscode-foreground);
                        font-family: var(--vscode-font-family, sans-serif);
                    }
                    .container {
                        display: flex;
                        flex-direction: row;
                        height: 100vh;
                    }
                    .sidebar {
                        min-width: 320px;
                        max-width: 400px;
                        padding: 16px;
                        border-right: 1px solid var(--vscode-editorWidget-border);
                        background: var(--vscode-sideBar-background);
                        overflow-y: auto;
                    }
                    .preview {
                        flex: 1;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        background: var(--vscode-editor-background);
                    }
                    .preview-btn {
                        font-size: 1em;
                        margin: 0;
                        border: 1px solid var(--vscode-input-border);
                        border-radius: 4px;
                        padding: 2px 8px;
                        cursor: pointer;
                        outline: none;
                        transition: background 0.1s, color 0.1s;
                        background: var(--vscode-input-background);
                        color: var(--vscode-input-foreground);
                    }
                    .preview-btn.selected {
                        background: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                    }
                    img {
                        max-width: 100%;
                        max-height: 90vh;
                        object-fit: contain;
                        background: var(--vscode-editor-background);
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="sidebar">
                        <h3>KTX2 Info</h3>
                        ${renderInfoTable(header)}
                        <div id="levelInfo">${this.renderLevelInfo(header, info.index, selection.level)}</div>
                        <h4>Preview Selection</h4>
                        <label>Level:
                            ${this.renderButtonGroup('level', levelCount, selection.level)}
                        </label><br/>
                        <label>Layer:
                            ${this.renderButtonGroup('layer', layerCount, selection.layer)}
                        </label><br/>
                        <label>Face:
                            ${this.renderButtonGroup('face', faceCount, selection.face)}
                        </label><br/>
                        <label>Depth:
                            ${this.renderButtonGroup('depth', depthCount, selection.depth)}
                        </label>
                    </div>
                    <div class="preview">
                        <img id="previewImg" src="data:image/png;base64,${imageData}" />
                    </div>
                </div>
                <script>
                    const vscode = acquireVsCodeApi();
                    let selection = {
                        level: ${selection.level},
                        layer: ${selection.layer},
                        face: ${selection.face},
                        depth: ${selection.depth}
                    };
                    function updateButtons(group, value) {
                        document.querySelectorAll('[data-group="'+group+'"]').forEach(btn => {
                            btn.classList.toggle('selected', parseInt(btn.getAttribute('data-value')) === value);
                        });
                    }
                    function sendSelection() {
                        vscode.postMessage({ type: 'extract', selection });
                    }
                    ['level','layer','face','depth'].forEach(group => {
                        document.getElementById(group+'-group').addEventListener('click', e => {
                            if (e.target && e.target.matches('button[data-value]')) {
                                const value = parseInt(e.target.getAttribute('data-value'));
                                selection[group] = value;
                                updateButtons(group, value);
                                sendSelection();
                            }
                        });
                    });
                    window.addEventListener('message', event => {
                        const msg = event.data;
                        if (msg.type === 'updateImage') {
                            document.getElementById('previewImg').src = 'data:image/png;base64,' + msg.base64Image;
                            document.getElementById('levelInfo').innerHTML = msg.levelInfoHtml;
                        }
                    });
                    // Set initial selected state
                    updateButtons('level', selection.level);
                    updateButtons('layer', selection.layer);
                    updateButtons('face', selection.face);
                    updateButtons('depth', selection.depth);
                </script>
            </body>
            </html>
        `;
    }

    private renderLevelInfo(header: any, index: any, level: number): string {
        if (!index || !index.levels || !index.levels[level]) return '';
        const lvl = index.levels[level];
        let res = '';
        if (header.pixelWidth && header.pixelHeight && header.levelCount) {
            // Calculate mip resolution
            const w = Math.max(1, header.pixelWidth >> level);
            const h = Math.max(1, header.pixelHeight >> level);
            res = `<tr><td style='font-weight:bold;padding:2px 8px;'>Resolution</td><td style='padding:2px 8px;'>${w} × ${h}</td></tr>`;
        }
        return `<table style='width:100%;margin-top:8px;color:var(--vscode-foreground);background:var(--vscode-editor-background);border-collapse:collapse;'>
            <tr><td colspan=2 style='font-weight:bold;padding:2px 8px;'>Selected Mip Level: ${level}</td></tr>
            ${res}
            ${Object.entries(lvl).map(([k, v]) => `<tr><td style='font-weight:bold;padding:2px 8px;'>${k}</td><td style='padding:2px 8px;'>${v}</td></tr>`).join('')}
        </table>`;
    }

    private renderButtonGroup(id: string, count: number, selected: number) {
        return `<div id="${id}-group" style="margin: 4px 0; display: flex; flex-wrap: wrap; gap: 4px;">
            ${Array.from({length: count}, (_, i) => `<button type="button" data-value="${i}" class="preview-btn${i===selected?' selected':''}" data-group="${id}">${i}</button>`).join('')}
        </div>`;
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