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

    // Add this property to the ExrPreviewEditorProvider class
    private colorDisplays: ColorDisplay[] = [];

    /**
     * Adjusts exposure and gamma for HDR images
     * @param inputPath Path to the input HDR image
     * @param outputPath Path to save the final adjusted PNG
     * @param exposure Exposure value in EV stops
     * @returns Promise resolving when adjustment is complete
     */
    private async adjustExposure(
        inputPath: string, 
        outputPath: string,
        exposure: number,
        runCommand: (cmd: string) => Promise<void>,
        display: string = 'sRGB - Display',
        view: string = 'ACES 1.0 - SDR Video'
    ): Promise<void> {
        const hdrExr = `${outputPath}_hdr.exr`;
        
        try {
            // Calculate exposure multiplier (2^EV)
            const exposureVal = Math.pow(2, exposure);

            // Special case for "No Tonemapping" option
            if (view === 'No Tonemapping') {
                // Just apply exposure and convert to output format without OCIO transforms
                // Fix for Blender EXRs: Apply exposure using a specific multiplication option
                const cmd = `oiiotool "${inputPath}" --mulc ${exposureVal} --colorconvert lin_rec709 sRGB -o "${outputPath}"`;
                console.log(`Adjusting exposure only (no tonemapping): ${exposure} EV`);
                console.log(cmd);
                await runCommand(cmd);
                return;
            }

            // Build command to adjust exposure and apply ACES tonemapping
            // For Blender EXRs, we need to explicitly set the input color space to lin_rec709
            const cmd = `oiiotool "${inputPath}" --mulc ${exposureVal} --ociodisplay "${display}" "${view}" -o "${outputPath}"`;
            
            console.log(`Adjusting exposure with: ${exposure} EV, display: ${display}, view: ${view}`);
            console.log(cmd);
            await runCommand(cmd);
        } finally {
            if (fs.existsSync(hdrExr)) {
                fs.unlinkSync(hdrExr);
            }
        }
    }

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

        // Get color config info
        const wrappedRunCommand = async (cmd: string): Promise<string> => {
            return new Promise((resolve, reject) => {
                cp.exec(cmd, (error, stdout) => {
                    if (error) reject(error);
                    else resolve(stdout);
                });
            });
        };
        
        this.colorDisplays = await getColorConfigInfo(wrappedRunCommand);

        try {
            const ext = path.extname(document.uri.fsPath).toLowerCase();
            if (ext === '.exr' || ext === '.hdr') {
                // Get image info first
                let imageInfo = '';
                let oiioInfo = '';
                
                if (ext === '.exr') {
                    // Get EXR-specific info
                    imageInfo = await new Promise<string>((resolve, reject) => {
                        cp.exec(`exrinfo "${document.uri.fsPath}"`, (error, stdout) => {
                            if (error) reject(error);
                            else resolve(stdout);
                        });
                    });
                }
                
                // Get OIIO info for both EXR and HDR files
                oiioInfo = await new Promise<string>((resolve, reject) => {
                    cp.exec(`oiiotool --info "${document.uri.fsPath}"`, (error, stdout) => {
                        if (error) reject(error);
                        else resolve(stdout);
                    });
                });

                // Apply ACES tonemapping to initial preview with default exposure of 0
                // Get default display and view
                const defaultDisplay = this.colorDisplays.find(d => d.isDefault) || this.colorDisplays[0];
                const defaultView = defaultDisplay?.views.find(v => v.isDefault) || defaultDisplay?.views[0];
                
                await this.adjustExposure(
                    document.uri.fsPath,
                    previewPath,
                    0, // Default exposure of 0 EV
                    runCommand,
                    defaultDisplay?.name || 'sRGB - Display',
                    defaultView?.name || 'ACES 1.0 - SDR Video'
                );
                
                const imageData = fs.readFileSync(previewPath);
                const base64Image = imageData.toString('base64');
                webviewPanel.webview.html = this.getHtmlForWebview(base64Image, {
                    exrInfo: imageInfo,
                    oiioInfo,
                    filename: path.basename(document.uri.fsPath)
                });
                if (fs.existsSync(previewPath)) {
                    fs.unlinkSync(previewPath);
                }
                
                // Add exposure control event handling
                webviewPanel.webview.onDidReceiveMessage(async (msg) => {
                    if (msg.type === 'adjustExposure') {
                        try {
                            // Get display and view settings
                            const display = msg.display || 'sRGB - Display';
                            const view = msg.view || 'ACES 1.0 - SDR Video';
                            
                            // Use the shared exposure adjustment function
                            await this.adjustExposure(
                                document.uri.fsPath,
                                previewPath,
                                msg.exposure,
                                runCommand,
                                display,
                                view
                            );
                            
                            const imageData = fs.readFileSync(previewPath);
                            const base64Image = imageData.toString('base64');
                            webviewPanel.webview.postMessage({ type: 'updateImage', base64Image });
                        } catch (e) {
                            vscode.window.showErrorMessage(`Failed to adjust exposure: ${e}`);
                        }
                    }
                });
                return;
            } else if (ext === '.ktx2') {
                // Get info JSON - Use the new robust method
                const info = await this.getKtx2Info(document.uri.fsPath);
                
                // Initial preview: level 0, layer 0, face 0, depth 0
                const selection = { level: 0, layer: 0, face: 0, depth: 0 };
                
                // Extract to EXR first
                try {
                    const extractedPath = await this.updateKtx2Preview(document.uri.fsPath, previewPath, selection, info);
                    
                    // Convert to PNG for display with ACES tonemapping
                    const initialDisplayPath = `${previewPath}_display.png`;
                    
                    // Get default display and view
                    const defaultDisplay = this.colorDisplays.find(d => d.isDefault) || this.colorDisplays[0];
                    const defaultView = defaultDisplay?.views.find(v => v.isDefault) || defaultDisplay?.views[0];
                    
                    await this.adjustExposure(
                        extractedPath,
                        initialDisplayPath,
                        0, // Default exposure of 0 EV
                        runCommand,
                        defaultDisplay?.name || 'sRGB - Display',
                        defaultView?.name || 'ACES 1.0 - SDR Video'
                    );
                    
                    const imageData = fs.readFileSync(initialDisplayPath);
                    const base64Image = imageData.toString('base64');
                    const levelInfoHtml = this.renderLevelInfo(info.header, info.index, selection.level);
                    webviewPanel.webview.html = this.getHtmlForKtx2Webview(base64Image, info, selection);
                    
                    // Clean up the files
                    if (fs.existsSync(extractedPath)) {
                        fs.unlinkSync(extractedPath);
                    }
                    if (fs.existsSync(initialDisplayPath)) {
                        fs.unlinkSync(initialDisplayPath);
                    }
                } catch (error) {
                    // Show error in the webview instead of failing completely
                    const extractError = error as Error;
                    const errorHtml = `
                        <div style="padding: 20px; color: var(--vscode-errorForeground);">
                            <h3>Failed to extract KTX2 image</h3>
                            <pre style="white-space: pre-wrap; overflow-wrap: break-word;">${extractError.toString()}</pre>
                            <p>This may be due to an unsupported or corrupted KTX2 file format.</p>
                        </div>
                    `;
                    webviewPanel.webview.html = `
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
                            </style>
                        </head>
                        <body>
                            ${errorHtml}
                        </body>
                        </html>
                    `;
                }
                
                // Listen for selection changes
                webviewPanel.webview.onDidReceiveMessage(async (msg) => {
                    if (msg.type === 'extract') {
                        try {
                            // Extract new selection to EXR
                            const extractedPath = await this.updateKtx2Preview(document.uri.fsPath, previewPath, msg.selection, info);
                            
                            // Convert to PNG for display with ACES tonemapping
                            const displayPath = `${previewPath}_display.png`;
                            
                            // Use the shared exposure adjustment function for consistent ACES tonemapping
                            // Use current exposure value if available, or default to 0
                            const exposure = msg.selection.exposure !== undefined ? msg.selection.exposure : 0;
                            
                            // Get display and view settings
                            const display = msg.display || 'sRGB - Display';
                            const view = msg.view || 'ACES 1.0 - SDR Video';
                            
                            await this.adjustExposure(
                                extractedPath,
                                displayPath,
                                exposure,
                                runCommand,
                                display,
                                view
                            );
                            
                            const imageData = fs.readFileSync(displayPath);
                            const base64Image = imageData.toString('base64');
                            const levelInfoHtml = this.renderLevelInfo(info.header, info.index, msg.selection.level);
                            webviewPanel.webview.postMessage({ type: 'updateImage', base64Image, levelInfoHtml });
                            
                            // Clean up temp files
                            if (fs.existsSync(extractedPath)) {
                                fs.unlinkSync(extractedPath);
                            }
                            if (fs.existsSync(displayPath)) {
                                fs.unlinkSync(displayPath);
                            }
                        } catch (e) {
                            vscode.window.showErrorMessage(`Failed to extract KTX2 part: ${e}`);
                        }
                    } else if (msg.type === 'adjustExposure') {
                        try {
                            // First extract the image part to EXR
                            const extractedPath = await this.updateKtx2Preview(document.uri.fsPath, previewPath, msg.selection, info);
                            
                            // Get display and view settings
                            const display = msg.display || msg.selection?.display || 'sRGB - Display';
                            const view = msg.view || msg.selection?.view || 'ACES 1.0 - SDR Video';
                            
                            // Use the shared exposure adjustment function
                            const displayPath = `${previewPath}_display.png`;
                            await this.adjustExposure(
                                extractedPath,
                                displayPath,
                                msg.exposure,
                                runCommand,
                                display,
                                view
                            );
                            
                            const imageData = fs.readFileSync(displayPath);
                            const base64Image = imageData.toString('base64');
                            webviewPanel.webview.postMessage({ type: 'updateImage', base64Image });
                            
                            // Clean up temp files
                            if (fs.existsSync(extractedPath)) {
                                fs.unlinkSync(extractedPath);
                            }
                            if (fs.existsSync(displayPath)) {
                                fs.unlinkSync(displayPath);
                            }
                        } catch (e) {
                            vscode.window.showErrorMessage(`Failed to adjust exposure: ${e}`);
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
        
        // Make sure we use the correct extension (.exr) for KTX extraction
        const extractPath = previewPath.endsWith('.exr') ? previewPath : `${previewPath}.exr`;
        
        // Extract to EXR format
        let cmd = `ktx extract --level ${selection.level}`;
        
        // Handle cubemaps with validation errors
        const isCubemap = (header.faceCount || 0) > 1;
        if (isCubemap) {
            cmd += ` --face ${selection.face}`;
            // For cubemaps, don't use depth parameter even if pixelDepth > 0
            // This addresses the error "Invalid pixelDepth. pixelDepth must be 0 for cube maps"
        } else if ((header.pixelDepth || 0) > 1) {
            // Only add depth for non-cubemaps
            cmd += ` --depth ${selection.depth}`;
        }
        
        // Add layer only if layerCount > 1
        if ((header.layerCount || 0) > 1) {
            cmd += ` --layer ${selection.layer}`;
        }
        
        cmd += ` "${ktx2Path}" "${extractPath}"`;
        
        console.log(`Extracting KTX2: ${cmd}`);
        
        try {
            await new Promise<void>((resolve, reject) => {
                cp.exec(cmd, (error) => {
                    if (error) {
                        console.warn(`KTX2 extraction failed with command: ${cmd}`);
                        console.warn(`Error: ${error.message}`);
                        
                        // Try fallback extraction without depth/layer for cubemaps
                        if (isCubemap) {
                            console.log("Trying fallback extraction for cubemap...");
                            const fallbackCmd = `ktx extract --level ${selection.level} --face ${selection.face} "${ktx2Path}" "${extractPath}"`;
                            cp.exec(fallbackCmd, (fallbackError) => {
                                if (fallbackError) {
                                    reject(fallbackError);
                                } else {
                                    resolve();
                                }
                            });
                        } else {
                            reject(error);
                        }
                    } else {
                        resolve();
                    }
                });
            });
        } catch (error) {
            console.error(`All KTX2 extraction attempts failed: ${error}`);
            throw error;
        }
        
        return extractPath;
    }

    // Add a helper method to get appropriate info from the KTX file even if validation fails
    private async getKtx2Info(filePath: string): Promise<any> {
        try {
            const infoJson = await new Promise<string>((resolve, reject) => {
                cp.exec(`ktx info --format json "${filePath}"`, (error, stdout) => {
                    if (error) {
                        console.warn(`KTX info command failed, trying without validation: ${error.message}`);
                        // Try again with any validation error messages filtered out
                        cp.exec(`ktx info --format json --format-json:validate=false "${filePath}"`, (fallbackError, fallbackStdout) => {
                            if (fallbackError) {
                                reject(fallbackError);
                            } else {
                                resolve(fallbackStdout);
                            }
                        });
                    } else {
                        resolve(stdout);
                    }
                });
            });
            
            try {
                return JSON.parse(infoJson);
            } catch (parseError) {
                console.warn(`Failed to parse KTX2 info JSON: ${parseError}`);
                // Extract the JSON part if there are validation errors in the output
                const jsonMatch = infoJson.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    return JSON.parse(jsonMatch[0]);
                }
                throw parseError;
            }
        } catch (error) {
            console.error(`Failed to get KTX2 info: ${error}`);
            // Return minimal info to allow basic functionality
            return {
                header: {
                    pixelWidth: 0,
                    pixelHeight: 0,
                    layerCount: 1,
                    faceCount: 1,
                    pixelDepth: 1,
                    levelCount: 1,
                    vkFormat: "Unknown"
                },
                index: { levels: [{}] }
            };
        }
    }

    private getHtmlForWebview(imageData: string, info?: any): string {
        const fileInfo = info ? `
            <div class="info-section">
                <h4>OIIO Info</h4>
                <pre>${info.oiioInfo || ''}</pre>
                <h4>EXR Info</h4>
                <pre>${info.exrInfo || ''}</pre>
            </div>
        ` : '';

        // Generate options HTML for displays and views
        const displaysOptions = this.colorDisplays.map(display => 
            `<option value="${display.name}" ${display.isDefault ? 'selected' : ''}>${display.name}</option>`
        ).join('');
        
        // Get default display
        const defaultDisplay = this.colorDisplays.find(d => d.isDefault) || this.colorDisplays[0];
        
        // Generate views for default display, add a "No Tonemapping" option
        const viewsOptions = 
            `<option value="No Tonemapping">No Tonemapping</option>` +
            defaultDisplay?.views.map(view => 
                `<option value="${view.name}" ${view.isDefault ? 'selected' : ''}>${view.name}</option>`
            ).join('') || '';
        
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
                        display: flex;
                        flex-direction: row;
                        height: 100vh;
                        background-color: var(--vscode-editor-background);
                        color: var(--vscode-foreground);
                        font-family: var(--vscode-font-family, sans-serif);
                    }
                    .sidebar {
                        min-width: 320px;
                        max-width: 400px;
                        padding: 16px;
                        border-right: 1px solid var(--vscode-editorWidget-border);
                        background: var(--vscode-sideBar-background);
                        overflow-y: auto;
                    }
                    .slider-container {
                        display: flex;
                        align-items: center;
                        margin-bottom: 10px;
                    }
                    .slider-container label {
                        width: 80px;
                    }
                    .slider-container input[type=range] {
                        flex: 1;
                        height: 4px;
                        -webkit-appearance: none;
                        background: var(--vscode-scrollbarSlider-background);
                        border-radius: 2px;
                        outline: none;
                    }
                    .slider-container input[type=range]::-webkit-slider-thumb {
                        -webkit-appearance: none;
                        width: 14px;
                        height: 14px;
                        border-radius: 50%;
                        background: var(--vscode-button-background);
                        cursor: pointer;
                        border: none;
                    }
                    .slider-container input[type=range]:focus {
                        outline: none;
                    }
                    .slider-container input[type=range]::-moz-range-thumb {
                        width: 14px;
                        height: 14px;
                        border-radius: 50%;
                        background: var(--vscode-button-background);
                        cursor: pointer;
                        border: none;
                    }
                    .slider-container input[type=range]::-ms-thumb {
                        width: 14px;
                        height: 14px;
                        border-radius: 50%;
                        background: var(--vscode-button-background);
                        cursor: pointer;
                        border: none;
                    }
                    .slider-value {
                        width: 60px;
                        text-align: right;
                        margin-left: 10px;
                        white-space: nowrap;
                    }
                    .preview {
                        flex: 1;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        background: var(--vscode-editor-background);
                    }
                    img {
                        max-width: 100%;
                        max-height: 100vh;
                        object-fit: contain;
                        image-rendering: pixelated; /* For nearest-neighbor filtering */
                    }
                    
                    /* Ensure image has at least one dimension of 512px */
                    .preview {
                        min-width: 512px;
                        min-height: 512px;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                    }
                    
                    /* JavaScript will dynamically add one of these classes */
                    img.landscape {
                        min-width: 512px;
                        height: auto;
                    }
                    
                    img.portrait {
                        width: auto;
                        min-height: 512px;
                    }
                    
                    img.square {
                        min-width: 512px;
                        min-height: 512px;
                    }
                    .info-section {
                        margin-top: 20px;
                        border-top: 1px solid var(--vscode-editorWidget-border);
                        padding-top: 10px;
                    }
                    pre {
                        font-family: var(--vscode-editor-font-family, monospace);
                        font-size: var(--vscode-editor-font-size, 12px);
                        background: var(--vscode-editor-background);
                        padding: 8px;
                        border-radius: 4px;
                        overflow: auto;
                        white-space: pre-wrap;
                        max-height: 200px;
                    }
                    h3, h4 {
                        margin-top: 10px;
                        margin-bottom: 8px;
                    }
                    .dropdown-container {
                        margin-bottom: 10px;
                    }
                    .dropdown-container label {
                        display: block;
                        margin-bottom: 4px;
                        font-weight: bold;
                    }
                    .dropdown-container select {
                        width: 100%;
                        padding: 4px;
                        background: var(--vscode-dropdown-background);
                        color: var(--vscode-dropdown-foreground);
                        border: 1px solid var(--vscode-dropdown-border);
                        border-radius: 2px;
                    }
                </style>
            </head>
            <body>
                <div class="sidebar">
                    <h3>HDR Controls</h3>
                    <div class="slider-container">
                        <label for="exposure">Exposure:</label>
                        <input type="range" id="exposure" min="-4" max="4" step="0.1" value="0">
                        <span class="slider-value" id="exposure-value">0 EV</span>
                    </div>
                    <div class="dropdown-container">
                        <label for="display">Display Device:</label>
                        <select id="display">
                            ${displaysOptions}
                        </select>
                    </div>
                    <div class="dropdown-container">
                        <label for="view">View Transform:</label>
                        <select id="view">
                            ${viewsOptions}
                        </select>
                    </div>
                    ${fileInfo}
                </div>
                <div class="preview">
                    <img id="previewImg" src="data:image/png;base64,${imageData}" />
                </div>
                <script>
                    const vscode = acquireVsCodeApi();
                    const exposureSlider = document.getElementById('exposure');
                    const exposureValue = document.getElementById('exposure-value');
                    const displaySelect = document.getElementById('display');
                    const viewSelect = document.getElementById('view');
                    
                    // Color config data
                    const colorDisplays = ${JSON.stringify(this.colorDisplays)};
                    
                    let lastExposure = 0;
                    let lastDisplay = displaySelect.value;
                    let lastView = viewSelect.value;
                    
                    // Handle display change - update view options
                    displaySelect.addEventListener('change', () => {
                        lastDisplay = displaySelect.value;
                        // Update view dropdown options
                        const selectedDisplay = colorDisplays.find(d => d.name === lastDisplay);
                        if (selectedDisplay) {
                            // Clear current options
                            viewSelect.innerHTML = '';
                            // Add "No Tonemapping" option
                            const noTonemappingOption = document.createElement('option');
                            noTonemappingOption.value = 'No Tonemapping';
                            noTonemappingOption.textContent = 'No Tonemapping';
                            // Check if "No Tonemapping" was previously selected
                            const wasNoTonemappingSelected = lastView === 'No Tonemapping';
                            noTonemappingOption.selected = wasNoTonemappingSelected;
                            viewSelect.appendChild(noTonemappingOption);
                            
                            // Add new options
                            selectedDisplay.views.forEach(view => {
                                const option = document.createElement('option');
                                option.value = view.name;
                                option.textContent = view.name;
                                option.selected = !wasNoTonemappingSelected && view.isDefault;
                                viewSelect.appendChild(option);
                            });
                            // Update lastView
                            lastView = viewSelect.value;
                        }
                        updateImage();
                    });
                    
                    viewSelect.addEventListener('change', () => {
                        lastView = viewSelect.value;
                        updateImage();
                    });
                    
                    exposureSlider.addEventListener('input', () => {
                        exposureValue.textContent = exposureSlider.value + ' EV';
                    });
                    
                    exposureSlider.addEventListener('change', () => {
                        lastExposure = parseFloat(exposureSlider.value);
                        updateImage();
                    });
                    
                    function updateImage() {
                        vscode.postMessage({ 
                            type: 'adjustExposure', 
                            exposure: lastExposure,
                            display: lastDisplay,
                            view: lastView
                        });
                    }
                    
                    window.addEventListener('message', event => {
                        const msg = event.data;
                        if (msg.type === 'updateImage') {
                            document.getElementById('previewImg').src = 'data:image/png;base64,' + msg.base64Image;
                        }
                    });
                    
                    // Add class to ensure minimum dimension is 512px
                    const img = document.getElementById('previewImg');
                    img.onload = function() {
                        if (img.naturalWidth > img.naturalHeight) {
                            img.className = 'landscape';
                        } else if (img.naturalWidth < img.naturalHeight) {
                            img.className = 'portrait';
                        } else {
                            img.className = 'square';
                        }
                    };
                </script>
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
        
        // Generate options HTML for displays and views
        const displaysOptions = this.colorDisplays.map(display => 
            `<option value="${display.name}" ${display.isDefault ? 'selected' : ''}>${display.name}</option>`
        ).join('');
        
        // Get default display
        const defaultDisplay = this.colorDisplays.find(d => d.isDefault) || this.colorDisplays[0] || { 
            name: 'sRGB - Display', 
            isDefault: true,
            views: [{ name: 'ACES 1.0 - SDR Video', isDefault: true }]
        };
        
        // Generate views for default display, add a "No Tonemapping" option
        const viewsOptions = 
            `<option value="No Tonemapping">No Tonemapping</option>` +
            defaultDisplay.views.map(view => 
                `<option value="${view.name}" ${view.isDefault ? 'selected' : ''}>${view.name}</option>`
            ).join('');
        
        // Default view name
        const defaultViewName = defaultDisplay.views.find(v => v.isDefault)?.name || 
            (defaultDisplay.views[0]?.name || 'ACES 1.0 - SDR Video');
        
        // Render info as a themed table
        function renderInfoTable(obj: any): string {
            return `<table style="width:100%;color:var(--vscode-foreground);background:var(--vscode-editor-background);border-collapse:collapse;">
                ${Object.entries(obj).map(([k, v]) => `<tr><td style="font-weight:bold;padding:2px 8px;width:30%;">${k}</td><td style="padding:2px 8px;max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${typeof v === 'object' ? JSON.stringify(v) : v}">${typeof v === 'object' ? JSON.stringify(v) : v}</td></tr>`).join('')}
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
                res = `<tr><td style='font-weight:bold;padding:2px 8px;width:30%;'>Resolution</td><td style='padding:2px 8px;max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' title='${w} × ${h}'>${w} × ${h}</td></tr>`;
            }
            return `<table style='width:100%;margin-top:8px;color:var(--vscode-foreground);background:var(--vscode-editor-background);border-collapse:collapse;'>
                <tr><td colspan=2 style='font-weight:bold;padding:2px 8px;'>Selected Mip Level: ${level}</td></tr>
                ${res}
                ${Object.entries(lvl).map(([k, v]) => `<tr><td style='font-weight:bold;padding:2px 8px;width:30%;'>${k}</td><td style='padding:2px 8px;max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' title='${v}'>${v}</td></tr>`).join('')}
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
                    .slider-container {
                        display: flex;
                        align-items: center;
                        margin-bottom: 10px;
                    }
                    .slider-container label {
                        width: 80px;
                    }
                    .slider-container input[type=range] {
                        flex: 1;
                        height: 4px;
                        -webkit-appearance: none;
                        background: var(--vscode-scrollbarSlider-background);
                        border-radius: 2px;
                        outline: none;
                    }
                    .slider-container input[type=range]::-webkit-slider-thumb {
                        -webkit-appearance: none;
                        width: 14px;
                        height: 14px;
                        border-radius: 50%;
                        background: var(--vscode-button-background);
                        cursor: pointer;
                        border: none;
                    }
                    .slider-container input[type=range]:focus {
                        outline: none;
                    }
                    .slider-container input[type=range]::-moz-range-thumb {
                        width: 14px;
                        height: 14px;
                        border-radius: 50%;
                        background: var(--vscode-button-background);
                        cursor: pointer;
                        border: none;
                    }
                    .slider-container input[type=range]::-ms-thumb {
                        width: 14px;
                        height: 14px;
                        border-radius: 50%;
                        background: var(--vscode-button-background);
                        cursor: pointer;
                        border: none;
                    }
                    .slider-value {
                        width: 60px;
                        text-align: right;
                        margin-left: 10px;
                        white-space: nowrap;
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
                        image-rendering: pixelated; /* For nearest-neighbor filtering */
                    }
                    
                    /* Ensure image has at least one dimension of 512px */
                    .preview-content {
                        min-width: 512px;
                        min-height: 512px;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                    }
                    
                    /* JavaScript will dynamically add one of these classes */
                    img.landscape {
                        min-width: 512px;
                        height: auto;
                    }
                    
                    img.portrait {
                        width: auto;
                        min-height: 512px;
                    }
                    
                    img.square {
                        min-width: 512px;
                        min-height: 512px;
                    }
                    .section {
                        margin-bottom: 20px;
                        padding-bottom: 10px;
                        border-bottom: 1px solid var(--vscode-editorWidget-border);
                    }
                    .dropdown-container {
                        margin-bottom: 10px;
                    }
                    .dropdown-container label {
                        display: block;
                        margin-bottom: 4px;
                        font-weight: bold;
                    }
                    .dropdown-container select {
                        width: 100%;
                        padding: 4px;
                        background: var(--vscode-dropdown-background);
                        color: var(--vscode-dropdown-foreground);
                        border: 1px solid var(--vscode-dropdown-border);
                        border-radius: 2px;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="sidebar">
                        <div class="section">
                            <h3>HDR Controls</h3>
                            <div class="slider-container">
                                <label for="exposure">Exposure:</label>
                                <input type="range" id="exposure" min="-4" max="4" step="0.1" value="0">
                                <span class="slider-value" id="exposure-value">0 EV</span>
                            </div>
                            <div class="dropdown-container">
                                <label for="display">Display Device:</label>
                                <select id="display">
                                    ${displaysOptions}
                                </select>
                            </div>
                            <div class="dropdown-container">
                                <label for="view">View Transform:</label>
                                <select id="view">
                                    ${viewsOptions}
                                </select>
                            </div>
                        </div>
                        
                        <div class="section">
                            <h3>KTX2 Info</h3>
                            ${header.vkFormat ? 
                                `<div style="margin-bottom:8px;">
                                    <div style="font-weight:bold;">vkFormat:</div>
                                    <pre style="margin:4px 0;padding:6px;background:var(--vscode-editor-background);border-radius:3px;overflow-x:auto;font-size:12px;">${header.vkFormat}</pre>
                                </div>` : ``
                            }
                            ${renderInfoTable(header.vkFormat ? 
                                Object.fromEntries(Object.entries(header).filter(([k]) => k !== 'vkFormat')) : 
                                header
                            )}
                            <div id="levelInfo">${this.renderLevelInfo(header, info.index, selection.level)}</div>
                        </div>
                        
                        <div class="section">
                            <h3>Preview Selection</h3>
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
                        depth: ${selection.depth},
                        exposure: 0,
                        display: '${defaultDisplay.name}',
                        view: '${defaultViewName}'
                    };
                    function updateButtons(group, value) {
                        document.querySelectorAll('[data-group="'+group+'"]').forEach(btn => {
                            btn.classList.toggle('selected', parseInt(btn.getAttribute('data-value')) === value);
                        });
                    }
                    function sendSelection() {
                        // Make sure to include the current display/view settings
                        vscode.postMessage({ 
                            type: 'extract', 
                            selection,
                            display: selection.display,
                            view: selection.view
                        });
                    }
                    function updateExposure() {
                        vscode.postMessage({ 
                            type: 'adjustExposure', 
                            exposure: selection.exposure,
                            display: selection.display,
                            view: selection.view,
                            selection: selection
                        });
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
                    
                    const exposureSlider = document.getElementById('exposure');
                    const exposureValue = document.getElementById('exposure-value');
                    
                    exposureSlider.addEventListener('input', () => {
                        exposureValue.textContent = exposureSlider.value + ' EV';
                    });
                    
                    exposureSlider.addEventListener('change', () => {
                        selection.exposure = parseFloat(exposureSlider.value);
                        updateExposure();
                    });
                    
                    window.addEventListener('message', event => {
                        const msg = event.data;
                        if (msg.type === 'updateImage') {
                            const img = document.getElementById('previewImg');
                            img.src = 'data:image/png;base64,' + msg.base64Image;
                            img.onload = function() {
                                if (img.naturalWidth > img.naturalHeight) {
                                    img.className = 'landscape';
                                } else if (img.naturalWidth < img.naturalHeight) {
                                    img.className = 'portrait';
                                } else {
                                    img.className = 'square';
                                }
                            };
                            if (msg.levelInfoHtml) {
                                document.getElementById('levelInfo').innerHTML = msg.levelInfoHtml;
                            }
                        }
                    });
                    
                    // Set initial image class for proper scaling
                    const img = document.getElementById('previewImg');
                    img.onload = function() {
                        if (img.naturalWidth > img.naturalHeight) {
                            img.className = 'landscape';
                        } else if (img.naturalWidth < img.naturalHeight) {
                            img.className = 'portrait';
                        } else {
                            img.className = 'square';
                        }
                    };
                    
                    // Set initial selected state
                    updateButtons('level', selection.level);
                    updateButtons('layer', selection.layer);
                    updateButtons('face', selection.face);
                    updateButtons('depth', selection.depth);
                    
                    // Handle display change - update view options
                    const displaySelect = document.getElementById('display');
                    const viewSelect = document.getElementById('view');
                    
                    // Color config data
                    const colorDisplays = ${JSON.stringify(this.colorDisplays)};
                    
                    displaySelect.addEventListener('change', () => {
                        selection.display = displaySelect.value;
                        // Update view dropdown options
                        const selectedDisplay = colorDisplays.find(d => d.name === selection.display);
                        if (selectedDisplay) {
                            // Clear current options
                            viewSelect.innerHTML = '';
                            // Add "No Tonemapping" option
                            const noTonemappingOption = document.createElement('option');
                            noTonemappingOption.value = 'No Tonemapping';
                            noTonemappingOption.textContent = 'No Tonemapping';
                            // Check if "No Tonemapping" was previously selected
                            const wasNoTonemappingSelected = selection.view === 'No Tonemapping';
                            noTonemappingOption.selected = wasNoTonemappingSelected;
                            viewSelect.appendChild(noTonemappingOption);
                            
                            // Add new options
                            selectedDisplay.views.forEach(view => {
                                const option = document.createElement('option');
                                option.value = view.name;
                                option.textContent = view.name;
                                option.selected = !wasNoTonemappingSelected && view.isDefault;
                                viewSelect.appendChild(option);
                            });
                            // Update view
                            selection.view = viewSelect.value;
                        }
                        updateExposure();
                    });
                    
                    viewSelect.addEventListener('change', () => {
                        selection.view = viewSelect.value;
                        updateExposure();
                    });
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
            res = `<tr><td style='font-weight:bold;padding:2px 8px;width:30%;'>Resolution</td><td style='padding:2px 8px;max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' title='${w} × ${h}'>${w} × ${h}</td></tr>`;
        }
        return `<table style='width:100%;margin-top:8px;color:var(--vscode-foreground);background:var(--vscode-editor-background);border-collapse:collapse;'>
            <tr><td colspan=2 style='font-weight:bold;padding:2px 8px;'>Selected Mip Level: ${level}</td></tr>
            ${res}
            ${Object.entries(lvl).map(([k, v]) => `<tr><td style='font-weight:bold;padding:2px 8px;width:30%;'>${k}</td><td style='padding:2px 8px;max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' title='${v}'>${v}</td></tr>`).join('')}
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

/**
 * Parse the output of oiiotool --colorconfiginfo into structured JSON
 */
interface ColorDisplay {
    name: string;
    isDefault: boolean;
    views: {
        name: string;
        isDefault: boolean;
    }[];
}

/**
 * Parses the output of oiiotool --colorconfiginfo into structured data
 */
async function parseColorConfigInfo(output: string): Promise<ColorDisplay[]> {
    const displays: ColorDisplay[] = [];
    
    const displaySection = output.split('Known displays:')[1]?.split('Named transforms:')[0];
    if (!displaySection) return displays;
    
    // Match display patterns like:
    // - "sRGB - Display" (*)
    //   views: "ACES 1.0 - SDR Video" (*), Un-tone-mapped, Raw
    const displayRegex = /- "([^"]+)"( \(\*\))?\n\s+views: (.+)$/gm;
    let match;
    
    while ((match = displayRegex.exec(displaySection)) !== null) {
        const displayName = match[1];
        const isDefault = match[2] !== undefined;
        const viewsLine = match[3];
        
        // Match view patterns like: "ACES 1.0 - SDR Video" (*), Un-tone-mapped, Raw
        const viewsMatches = viewsLine.match(/"([^"]+)"( \(\*\))?/g) || [];
        
        const views = viewsMatches.map(viewMatch => {
            const viewName = viewMatch.match(/"([^"]+)"/)?.[1] || '';
            const isViewDefault = viewMatch.includes('(*)');
            return { name: viewName, isDefault: isViewDefault };
        });
        
        displays.push({ name: displayName, isDefault, views });
    }
    
    return displays;
}

/**
 * Retrieves color configuration information from OIIO
 */
async function getColorConfigInfo(runCommand: (cmd: string) => Promise<string>): Promise<ColorDisplay[]> {
    try {
        const output = await runCommand('oiiotool --colorconfiginfo');
        return parseColorConfigInfo(output);
    } catch (error) {
        console.error('Failed to get color config info:', error);
        // Return default display/view as fallback
        return [
            {
                name: 'sRGB - Display',
                isDefault: true,
                views: [{ name: 'ACES 1.0 - SDR Video', isDefault: true }]
            }
        ];
    }
}

export function deactivate() {} 