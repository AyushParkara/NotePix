var import_obsidian = require("obsidian");
// NOTE: Do not use Node's 'path' on mobile; provide a small POSIX join using Obsidian's normalizePath
function joinRepoPath(folderPath, fileName) {
    const raw = (folderPath || "").replace(/\\/g, "/").trim();
    const folder = raw.replace(/^\/+|\/+$/g, "");
    const combined = folder ? `${folder}/${fileName}` : fileName;
    try {
        return import_obsidian.normalizePath ? import_obsidian.normalizePath(combined) : combined.replace(/\/+/g, "/");
    } catch (_) {
        return combined.replace(/\/+/g, "/");
    }
}

// Convert binary data to base64 without quadratic string concatenation costs.
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 32768;
    const chunks = [];
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        chunks.push(String.fromCharCode.apply(null, chunk));
    }
    return btoa(chunks.join(""));
}

function escapeRegex(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Platform detection
const isMobile = !!(import_obsidian.Platform && import_obsidian.Platform.isMobile);

// CodeMirror 6 view classes for Live Preview rendering (issue #6). Obsidian
// overloads require("@codemirror/*") at runtime to return its own internal
// instances, so no bundling is needed. Wrapped in try/catch so the plugin still
// loads if these are ever unavailable (older builds / unexpected environments).
let cm6View = null;
try { cm6View = require("@codemirror/view"); } catch (_) { cm6View = null; }

// crypto.ts
var PBKDF2_ITERATIONS = 1e5;
var ALGORITHM = "AES-GCM";
async function getKey(password, salt) {
    const passwordBuffer = new TextEncoder().encode(password);
    const baseKey = await crypto.subtle.importKey(
        "raw",
        passwordBuffer,
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt,
            iterations: PBKDF2_ITERATIONS,
            hash: "SHA-256"
        },
        baseKey,
        { name: ALGORITHM, length: 256 },
        true,
        ["encrypt", "decrypt"]
    );
}
async function encrypt(plaintext, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await getKey(password, salt);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encodedPlaintext = new TextEncoder().encode(plaintext);
    const encryptedContent = await crypto.subtle.encrypt(
        { name: ALGORITHM, iv },
        key,
        encodedPlaintext
    );
    const saltB64 = btoa(String.fromCharCode(...new Uint8Array(salt)));
    const ivB64 = btoa(String.fromCharCode(...new Uint8Array(iv)));
    const encryptedB64 = btoa(String.fromCharCode(...new Uint8Array(encryptedContent)));
    return `${saltB64}:${ivB64}:${encryptedB64}`;
}
async function decrypt(encryptedString, password) {
    const [saltB64, ivB64, encryptedB64] = encryptedString.split(":");
    if (!saltB64 || !ivB64 || !encryptedB64) {
        throw new Error("Invalid encrypted data format.");
    }
    const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
    const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
    const encryptedContent = Uint8Array.from(atob(encryptedB64), c => c.charCodeAt(0));
    const key = await getKey(password, salt);
    const decryptedContent = await crypto.subtle.decrypt(
        { name: ALGORITHM, iv },
        key,
        encryptedContent
    );
    return new TextDecoder().decode(decryptedContent);
}

// main.ts
var DEFAULT_SETTINGS = {
    githubUser: "",
    repoName: "",
    encryptedToken: "",
    plainToken: "",
    branchName: "main",
    folderPath: "assets/",
    deleteLocal: false,
    useEncryption: true,
    repoVisibility: 'auto',
    repoHistory: [],
    uploadOnPaste: 'always',
    localImageFolder: 'notepix-local',
    uploadImageFolder: 'notepix-uploads',
    autoUpload: true,
    extraWatchedFolders: '',
    extraWatchedList: [],
    localOnlyFolders: '',
    localOnlyList: [],
    // Mobile integration defaults (safe no-ops on desktop)
    attachmentsFolderName: 'attachment',
    integrateAttachmentsOnMobile: true,
    // Repo mismatch prompt suppression
    lastPromptedAt: 0,
    lastPromptedRepo: '',
    // Optional extra: jsDelivr CDN links for PUBLIC repos (off by default).
    // jsDelivr only serves public repos, so this is ignored/forced-off for
    // private repos (and in auto mode when a private repo is detected).
    useCdn: false,
    // Optional extra: where uploads are stored in the repo.
    //   'global'     -> everything in folderPath (default, current behavior)
    //   'byNotePath' -> mirror the note's vault path under byNotePathBaseFolder
    imageStorageStrategy: 'global',
    byNotePathBaseFolder: 'assets',
    // Optional extra: name pasted images after the heading they sit under,
    //   e.g. "Installation-1.png" (off by default → timestamp names). Stable:
    //   based on heading TEXT, not position, so inserting headings elsewhere
    //   never renames anything (no destructive renumber needed).
    headingBasedNaming: false,
    // Persisted per-(note|heading) running counters for headingBasedNaming.
    imageCounters: {}
};
var MyPlugin = class extends import_obsidian.Plugin {
    constructor() {
        super(...arguments);
        // This will hold the decrypted token in memory for the session
        this.decryptedToken = null;
        this.isPromptingForPassword = false;
        this.mobileAttachmentFolder = '';
        this.userApprovedUploads = new Map();
        // From enhanced mobile version: track pending link replacements and recent placeholders
        this.pendingLinkReplacements = new Map();
        this.recentPlaceholdersByName = new Map();
        // Repo privacy detection cache: { value, timestamp, user, repo }
        this.repoPrivacyCache = null;
        this._fileOpenDebounceTimer = null;
        this._mismatchNoticeShown = false;
        this._lastRenderTokenNoticeAt = 0;
        this.failedImageFetches = new Map();
        this.pendingLegacyMigrations = new Map();
        this.pendingLegacyMigrationTimers = new Map();
        this.repoListCache = null;
        this.legacyResolvedRepoByKey = new Map();
        this.legacyUnresolvedUntil = new Map();
    }
    getVaultFolderPaths() {
        const res = [];
        const root = this.app.vault.getRoot();
        const walk = (folder) => {
            const p = (folder.path || "").replace(/^\/+|\/+$/g, "");
            res.push(p);
            const children = folder.children || [];
            for (const child of children) {
                if (child instanceof import_obsidian.TFolder) {
                    walk(child);
                }
            }
        };
        walk(root);
        return res;
    }
    normalizeVaultPath(path) {
        return (path || '').replace(/\\\\/g, "/").replace(/^\/+|\/+$/g, "");
    }
    getLegacyRepoCandidates(primaryRepo) {
        const normalizedPrimary = (primaryRepo || '').trim();
        const history = Array.isArray(this.settings.repoHistory) ? this.settings.repoHistory : [];
        const set = new Set();

        if (normalizedPrimary) set.add(normalizedPrimary);

        for (const entry of history) {
            const repo = String(entry || '').trim();
            if (repo) set.add(repo);
        }

        // Heuristic fallback for common rename pattern: singular <-> plural.
        if (normalizedPrimary) {
            if (normalizedPrimary.endsWith('s') && normalizedPrimary.length > 1) {
                set.add(normalizedPrimary.slice(0, -1));
            } else {
                set.add(`${normalizedPrimary}s`);
            }
        }

        return Array.from(set.values());
    }
    clearRepoListCache() {
        this.repoListCache = null;
        if (this.legacyResolvedRepoByKey) {
            this.legacyResolvedRepoByKey.clear();
        }
        if (this.legacyUnresolvedUntil) {
            this.legacyUnresolvedUntil.clear();
        }
    }
    async getConfiguredUserRepoList(token) {
        const configuredUser = (this.settings.githubUser || '').trim();
        if (!configuredUser || !token) return [];

        if (this.repoListCache &&
            this.repoListCache.user === configuredUser &&
            (Date.now() - this.repoListCache.timestamp) < 10 * 60 * 1000) {
            return this.repoListCache.repos || [];
        }

        try {
            const collected = [];
            const userLower = configuredUser.toLowerCase();
            for (let page = 1; page <= 10; page++) {
                const url = `https://api.github.com/user/repos?per_page=100&page=${page}&sort=updated&direction=desc&type=all&affiliation=owner,collaborator,organization_member`;
                const response = await fetch(url, {
                    headers: {
                        "Authorization": `token ${token}`,
                        "Accept": "application/vnd.github.v3+json"
                    }
                });
                if (!response.ok) break;
                const arr = await response.json();
                if (!Array.isArray(arr) || arr.length === 0) break;

                for (const repo of arr) {
                    const ownerLogin = String(repo?.owner?.login || '').toLowerCase();
                    const name = String(repo?.name || '').trim();
                    if (name && ownerLogin === userLower) {
                        collected.push(name);
                    }
                }
                if (arr.length < 100) break;
            }

            const unique = Array.from(new Set(collected));
            this.repoListCache = {
                user: configuredUser,
                repos: unique,
                timestamp: Date.now()
            };
            return unique;
        } catch (e) {
            console.error('NotePix: Failed to fetch repo list for configured user', e);
            return [];
        }
    }
    queueLegacyLinkMigration(sourcePath, oldUrl, newUrl) {
        const path = (sourcePath || '').trim();
        if (!path || !oldUrl || !newUrl || oldUrl === newUrl) return;

        let map = this.pendingLegacyMigrations.get(path);
        if (!map) {
            map = new Map();
            this.pendingLegacyMigrations.set(path, map);
        }
        map.set(oldUrl, newUrl);

        const existing = this.pendingLegacyMigrationTimers.get(path);
        if (existing) {
            clearTimeout(existing);
        }

        const timer = setTimeout(() => {
            this.applyLegacyLinkMigrations(path);
        }, 800);
        this.pendingLegacyMigrationTimers.set(path, timer);
    }
    async applyLegacyLinkMigrations(sourcePath) {
        const path = (sourcePath || '').trim();
        if (!path) return;

        const timer = this.pendingLegacyMigrationTimers.get(path);
        if (timer) {
            clearTimeout(timer);
            this.pendingLegacyMigrationTimers.delete(path);
        }

        const migrations = this.pendingLegacyMigrations.get(path);
        if (!migrations || migrations.size === 0) return;
        this.pendingLegacyMigrations.delete(path);

        try {
            const abs = this.app.vault.getAbstractFileByPath(path);
            if (!(abs instanceof import_obsidian.TFile) || !abs.path.endsWith('.md')) return;
            const startMtime = abs.stat?.mtime || 0;

            const content = await this.app.vault.read(abs);
            let updated = content;
            let replacedCount = 0;

            for (const [oldUrl, newUrl] of migrations.entries()) {
                if (!oldUrl || !newUrl || oldUrl === newUrl) continue;
                if (!updated.includes(oldUrl)) continue;
                updated = updated.split(oldUrl).join(newUrl);
                replacedCount++;
            }

            if (updated !== content) {
                const latest = this.app.vault.getAbstractFileByPath(path);
                const latestMtime = (latest instanceof import_obsidian.TFile) ? (latest.stat?.mtime || 0) : 0;
                if (startMtime && latestMtime && latestMtime !== startMtime) {
                    // File changed while migration was preparing; requeue to avoid clobbering newer edits.
                    let map = this.pendingLegacyMigrations.get(path);
                    if (!map) {
                        map = new Map();
                        this.pendingLegacyMigrations.set(path, map);
                    }
                    for (const [oldUrl, newUrl] of migrations.entries()) {
                        map.set(oldUrl, newUrl);
                    }
                    if (!this.pendingLegacyMigrationTimers.get(path)) {
                        const retryTimer = setTimeout(() => {
                            this.applyLegacyLinkMigrations(path);
                        }, 1200);
                        this.pendingLegacyMigrationTimers.set(path, retryTimer);
                    }
                    return;
                }
                await this.app.vault.modify(abs, updated);
                new import_obsidian.Notice(`NotePix: Migrated ${replacedCount} legacy image link(s) to v2 format.`, 3500);
            }
        } catch (e) {
            console.error('NotePix: Failed to migrate legacy links', e);
        }
    }
    markFileAsUserApproved(path) {
        const norm = this.normalizeVaultPath(path);
        if (!norm) return;
        const existing = this.userApprovedUploads.get(norm);
        if (existing) {
            clearTimeout(existing);
        }
        const timeoutId = setTimeout(() => {
            this.userApprovedUploads.delete(norm);
        }, 6e4);
        this.userApprovedUploads.set(norm, timeoutId);
    }
    consumeUserApprovedUpload(path) {
        const norm = this.normalizeVaultPath(path);
        if (!norm) return false;
        const timeoutId = this.userApprovedUploads.get(norm);
        if (!timeoutId) return false;
        clearTimeout(timeoutId);
        this.userApprovedUploads.delete(norm);
        return true;
    }
    // From enhanced mobile version: primary local folder + helpers
    getPrimaryLocalFolderPath() {
        const fromList = (Array.isArray(this.settings.localOnlyList) && this.settings.localOnlyList.length > 0)
            ? (this.settings.localOnlyList[0]?.path || this.settings.localOnlyList[0] || '')
            : (this.settings.localImageFolder || 'notepix-local');
        const cleaned = this.normalizeVaultPath(fromList || 'notepix-local');
        return cleaned || 'notepix-local';
    }
    async ensureFolderExists(folderPath) {
        if (!folderPath) return;
        try {
            await this.app.vault.createFolder(folderPath);
        } catch (_) {
            // already exists
        }
    }
    async moveFileToLocalOnly(file) {
        if (!file) return null;
        const originalPath = file.path;
        const originalName = file.name;
        const folderPath = this.getPrimaryLocalFolderPath();
        if (!folderPath) return null;
        await this.ensureFolderExists(folderPath);
        const hasExtension = !!(file.extension || (originalName && originalName.includes('.')));
        const extension = hasExtension ? (file.extension || originalName.split('.').pop()) : '';
        const baseName = hasExtension && originalName ? originalName.slice(0, -(extension.length + 1)) : originalName;
        let counter = 1;
        let targetPath = `${folderPath}/${originalName}`;
        const adapter = this.app.vault.adapter;
        while (await adapter.exists(targetPath)) {
            const suffix = baseName ? `${baseName}-${counter}` : `image-${counter}`;
            targetPath = hasExtension ? `${folderPath}/${suffix}.${extension}` : `${folderPath}/${suffix}`;
            counter++;
        }
        await this.app.vault.rename(file, targetPath);
        return { newPath: targetPath, originalPath, originalName };
    }
    // Mobile-only: track wikilinks inserted into the editor by filename
    registerMobileEditorPlaceholderTracking() {
        if (!isMobile) return;
        const attachHandler = (leaf) => {
            const view = leaf?.view;
            if (!view || !(view instanceof import_obsidian.MarkdownView)) return;
            const editor = view.editor;
            if (!editor) return;
            const cm = editor.cm || editor;
            if (!cm || typeof cm.on !== 'function') return;
            const handler = (instance, changeObj) => {
                try {
                    const text = changeObj?.text;
                    if (!text || !Array.isArray(text)) return;
                    const joined = text.join('\n');
                    if (!joined) return;
                    const wikiRegex = /!\[\[([^\]]+)\]\]/g;
                    const mdImgRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
                    let m;
                    const now = Date.now();
                    while ((m = wikiRegex.exec(joined)) !== null) {
                        const inner = m[1] || '';
                        const fileName = inner.split('|')[0].split('/').pop();
                        if (!fileName) continue;
                        this.recentPlaceholdersByName.set(fileName, {
                            placeholder: m[0],
                            ts: now
                        });
                    }
                    while ((m = mdImgRegex.exec(joined)) !== null) {
                        const pathPart = m[1] || '';
                        const fileName = decodeURIComponent(pathPart.split('/').pop() || '');
                        if (!fileName) continue;
                        this.recentPlaceholdersByName.set(fileName, {
                            placeholder: m[0],
                            ts: now
                        });
                    }
                    // Drop entries older than 60s
                    for (const [name, rec] of this.recentPlaceholdersByName.entries()) {
                        if (!rec || typeof rec.ts !== 'number') continue;
                        if (now - rec.ts > 60 * 1000) {
                            this.recentPlaceholdersByName.delete(name);
                        }
                    }
                } catch (e) {
                    console.error('NotePix: error tracking mobile placeholders', e);
                }
            };
            cm.on('change', handler);
            this.register(() => {
                try {
                    cm.off('change', handler);
                } catch (_) { }
            });
        };
        this.registerEvent(this.app.workspace.on('active-leaf-change', attachHandler));
        const activeLeaf = this.app.workspace.activeLeaf;
        if (activeLeaf) attachHandler(activeLeaf);
    }
    recordPendingLinkPlaceholder(path, placeholderText, sourcePath = "") {
        const norm = this.normalizeVaultPath(path);
        if (!norm || !placeholderText) return;
        const sourcePathNorm = this.normalizeVaultPath(sourcePath || "");
        const entry = this.pendingLinkReplacements.get(norm);
        if (entry?.timeoutId) {
            clearTimeout(entry.timeoutId);
        }
        const timeoutId = setTimeout(() => {
            this.pendingLinkReplacements.delete(norm);
        }, 5 * 60 * 1e3);
        this.pendingLinkReplacements.set(norm, { placeholderText, sourcePath: sourcePathNorm, timeoutId });
    }
    peekPendingLinkPlaceholder(pathOrKey) {
        const norm = this.normalizeVaultPath(pathOrKey);
        const key = norm || pathOrKey;
        if (!key) return null;
        const entry = this.pendingLinkReplacements.get(key);
        if (!entry) return null;
        return {
            key,
            placeholderText: entry.placeholderText || null,
            sourcePath: entry.sourcePath || ""
        };
    }
    consumePendingLinkPlaceholder(pathOrKey) {
        const norm = this.normalizeVaultPath(pathOrKey);
        const key = norm || pathOrKey;
        if (!key) return null;
        const entry = this.pendingLinkReplacements.get(key);
        if (!entry) return null;
        if (entry.timeoutId) {
            clearTimeout(entry.timeoutId);
        }
        this.pendingLinkReplacements.delete(key);
        return {
            key,
            placeholderText: entry.placeholderText || null,
            sourcePath: entry.sourcePath || ""
        };
    }
    async promptUploadConfirmation(file) {
        const modal = new ConfirmationModal(this.app, "Upload Image?", `Do you want to upload ${file.name} to GitHub?`);
        return await modal.open();
    }
    async onload() {
        await this.loadSettings();
        this.addSettingTab(new GitHubUploaderSettingTab(this.app, this));

        // Initialize an in-memory cache for private images
        this.imageCache = new Map();

        // Mobile-only: track recently inserted image placeholders in the editor
        this.registerMobileEditorPlaceholderTracking();

        // MOBILE-ONLY: Integrate Obsidian attachments with NotePix (baseline behavior)
        if (isMobile && (this.settings.integrateAttachmentsOnMobile !== false)) {
            try {
                const attachFolder = (this.settings.attachmentsFolderName || 'attachment')
                    .replace(/\\\\/g, "/")
                    .replace(/^\/+|\/+$/g, "");
                if (attachFolder) {
                    try { await this.app.vault.createFolder(attachFolder); } catch (_) { /* exists */ }
                    try { this.app.vault.setConfig('attachmentFolderPath', attachFolder); } catch (_) { /* ignore */ }
                    this.mobileAttachmentFolder = attachFolder;
                }
            } catch (_) { /* ignore mobile integration errors */ }
        }

        // Register the processor that will handle our custom image URLs
        this.registerMarkdownPostProcessor(this.postProcessImages.bind(this));

        // Issue #6: render private (v2) images in Live Preview (edit mode).
        // Inactive (no-op) if CM6 view classes are unavailable; Reading View
        // rendering via postProcessImages is unaffected either way.
        try {
            const lpExtension = this.buildLivePreviewExtension();
            if (lpExtension) this.registerEditorExtension(lpExtension);
        } catch (e) {
            console.error("NotePix: failed to register Live Preview extension", e);
        }

        // Command: upload images that are ALREADY embedded in the current note.
        // Additive feature (issue #8): does not change paste/drag/auto-upload flows.
        this.addCommand({
            id: 'upload-all-local-images-in-note',
            name: 'Upload all local images in current note',
            editorCallback: (editor, view) => {
                const activeFile = view?.file;
                if (!activeFile) {
                    new import_obsidian.Notice("No active note found.");
                    return;
                }
                this.uploadAllLocalImagesInNote(activeFile);
            }
        });

        // Issue #7: editor right-click → delete the NotePix image under the cursor
        // (GitHub + note), with multi-note guard. Editor-only by design (BP-2).
        this.registerEvent(
            this.app.workspace.on("editor-menu", (menu, editor, view) => {
                try {
                    const cursor = editor.getCursor();
                    const lineText = editor.getLine(cursor.line);
                    const found = this.findManagedEmbedOnLine(lineText, cursor.ch);
                    if (!found) return; // no NotePix image here → no menu item
                    menu.addItem((item) => {
                        item.setTitle("NotePix: Delete image (GitHub + note)")
                            .setIcon("trash")
                            .onClick(() => this.handleDeleteImageAtCursor(editor, view));
                    });
                } catch (e) {
                    console.error("NotePix: editor-menu handler error", e);
                }
            })
        );

        // Issue #7: command to find and review orphaned GitHub images (report-only).
        this.addCommand({
            id: 'find-orphan-images',
            name: 'Find orphaned images on GitHub (review before deleting)',
            callback: () => this.findOrphanImages()
        });

        // Issue #7: multi-select delete — checklist of the current note's images.
        this.addCommand({
            id: 'delete-images-in-note',
            name: 'Delete images in current note (multi-select)',
            editorCallback: () => this.openMultiDeleteForActiveNote()
        });

        // Optional extra: convert image link format in the current note (public).
        this.addCommand({
            id: 'convert-note-links-to-cdn',
            name: 'Convert image links in note to jsDelivr CDN',
            editorCallback: (editor, view) => {
                if (view?.file) this.convertNoteLinkFormat(view.file, 'cdn');
            }
        });
        this.addCommand({
            id: 'convert-note-links-to-raw',
            name: 'Convert image links in note to GitHub raw',
            editorCallback: (editor, view) => {
                if (view?.file) this.convertNoteLinkFormat(view.file, 'raw');
            }
        });

        // Paste handler (baseline behavior)
        this.registerEvent(
            this.app.workspace.on("editor-paste", this.handlePaste.bind(this))
        );

        // Vault create watcher (baseline + captureFilePlaceholder + handleDeclinedUpload)
        this.registerEvent(
            this.app.vault.on("create", async (file) => {
                if (!(file instanceof import_obsidian.TFile)) return;
                const imageExtensions = ["png", "jpg", "jpeg", "gif", "bmp", "svg"];
                if (!imageExtensions.includes(file.extension.toLowerCase())) return;

                const filePathNorm = file.path.replace(/\\\\/g, "/");
                const localOnly = (Array.isArray(this.settings.localOnlyList) && this.settings.localOnlyList.length > 0
                    ? this.settings.localOnlyList
                    : (this.settings.localOnlyFolders || this.settings.localImageFolder || 'notepix-local').split(','))
                    .map(s => (typeof s === 'string' ? s : s.path || ''))
                    .map(s => (s || '').trim())
                    .filter(Boolean)
                    .map(s => s.replace(/\\\\/g, "/").replace(/^\/+|\/+$/g, ""));
                // Always ignore any local-only folders (explicitly not for upload)
                if (localOnly.some(ign => filePathNorm === ign || filePathNorm.startsWith(ign + "/"))) return;

                // Only auto-upload if enabled and inside a watched folder
                if (!this.settings.autoUpload) return;

                const uploadNorm = (this.settings.uploadImageFolder || 'notepix-uploads')
                    .replace(/\\\\/g, "/")
                    .replace(/^\/+|\/+$/g, "");
                const extra = (Array.isArray(this.settings.extraWatchedList) && this.settings.extraWatchedList.length > 0
                    ? this.settings.extraWatchedList.map(e => e?.path || '')
                    : (this.settings.extraWatchedFolders || '').split(','))
                    .map(s => (s || '').trim())
                    .filter(Boolean)
                    .map(s => s.replace(/\\\\/g, "/").replace(/^\/+|\/+$/g, ""));

                const attachNorm = (this.mobileAttachmentFolder || '')
                    .replace(/\\\\/g, "/")
                    .replace(/^\/+|\/+$/g, "");

                const inUpload = uploadNorm && (filePathNorm === uploadNorm || filePathNorm.startsWith(uploadNorm + "/"));
                const inExtra = extra.some(f => filePathNorm === f || filePathNorm.startsWith(f + "/"));
                const inAttach = attachNorm && (filePathNorm === attachNorm || filePathNorm.startsWith(attachNorm + "/"));
                if (!(inUpload || inExtra || inAttach)) return;

                // Try to capture placeholder for later replacement (Android attachments)
                this.captureFilePlaceholder(file);

                const alreadyConfirmed = this.consumeUserApprovedUpload(file.path);
                const shouldPrompt = (this.settings.uploadOnPaste === 'ask') && !alreadyConfirmed;

                if (shouldPrompt) {
                    const confirmed = await this.promptUploadConfirmation(file);
                    if (confirmed) {
                        await this.handleImageUpload(file);
                    } else {
                        await this.handleDeclinedUpload(file);
                    }
                    return;
                }

                await this.handleImageUpload(file);
            })
        );

        // File-open maintenance: sanitize malformed links, then run mismatch check
        this.registerEvent(
            this.app.workspace.on("file-open", async (file) => {
                if (!file) return;
                await this.sanitizeFileOnOpen(file);
                this.checkRepoMismatchOnFileOpen(file);
            })
        );
    }

    onunload() {
        // Clear the decrypted token from memory
        this.decryptedToken = null;
        // Clear repo privacy cache and debounce timer
        this.repoPrivacyCache = null;
        if (this._fileOpenDebounceTimer) {
            clearTimeout(this._fileOpenDebounceTimer);
            this._fileOpenDebounceTimer = null;
        }

        // IMPORTANT: Revoke all created blob URLs to prevent memory leaks
        if (this.imageCache) {
            this.imageCache.forEach(url => URL.revokeObjectURL(url));
            this.imageCache.clear();
        }
        if (this.userApprovedUploads) {
            this.userApprovedUploads.forEach((timeoutId) => clearTimeout(timeoutId));
            this.userApprovedUploads.clear();
        }
        if (this.pendingLinkReplacements) {
            this.pendingLinkReplacements.forEach(entry => {
                if (entry?.timeoutId) clearTimeout(entry.timeoutId);
            });
            this.pendingLinkReplacements.clear();
        }
        if (this.failedImageFetches) {
            this.failedImageFetches.clear();
        }
        if (this.pendingLegacyMigrationTimers) {
            this.pendingLegacyMigrationTimers.forEach((timer) => clearTimeout(timer));
            this.pendingLegacyMigrationTimers.clear();
        }
        if (this.pendingLegacyMigrations) {
            this.pendingLegacyMigrations.clear();
        }
        this.repoListCache = null;
        if (this.legacyResolvedRepoByKey) {
            this.legacyResolvedRepoByKey.clear();
        }
        if (this.legacyUnresolvedUntil) {
            this.legacyUnresolvedUntil.clear();
        }
    }
    async handlePaste(evt) {
        const files = evt.clipboardData?.files;
        if (!files || files.length === 0) {
            return;
        }
        const imageFile = Array.from(files).find(file => file.type.startsWith("image/"));
        if (!imageFile) {
            return;
        }

        // If uploadOnPaste is 'always', just upload and finish.
        if (this.settings.uploadOnPaste === 'always') {
            evt.preventDefault();
            await this.uploadPastedImage(imageFile);
            return;
        }

        // If uploadOnPaste is 'ask', we begin the full logic.
        if (this.settings.uploadOnPaste === 'ask') {
            evt.preventDefault(); // Take control of the paste event.

            const modal = new ConfirmationModal(this.app, "Upload Image?", "Do you want to upload this image to GitHub?");
            const confirmed = await modal.open();

            if (confirmed) {
                // If confirmed, proceed with the upload.
                await this.uploadPastedImage(imageFile);
            } else {
                // If not confirmed, save the image locally.
                await this.saveImageLocally(imageFile);
            }
        }
        // If uploadOnPaste is set to something else, do nothing and let Obsidian handle it.
    }

    async uploadPastedImage(imageFile) {
        // Save the image into the configured upload folder, so watcher logic is consistent
        const arrayBuffer = await imageFile.arrayBuffer();
        const activeView = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
        if (!activeView) {
            new import_obsidian.Notice("Cannot process image: No active editor view.");
            return;
        }

        const uploadFolder = (this.settings.uploadImageFolder || 'notepix-uploads')
            .replace(/\\\\/g, "/")
            .replace(/^\/+|\/+$/g, "");
        try {
            if (uploadFolder) {
                await this.app.vault.createFolder(uploadFolder);
            }
        } catch { }

        const noteName = activeView.file ? activeView.file.basename : 'Untitled';
        const extension = imageFile.name.split('.').pop() || 'png';
        let i = 1;
        let newFilePath;
        do {
            newFilePath = uploadFolder
                ? `${uploadFolder}/${noteName}-${i}.${extension}`
                : `${noteName}-${i}.${extension}`;
            i++;
        } while (await this.app.vault.adapter.exists(newFilePath));

        // Pre-approve the path BEFORE createBinary so the vault 'create' watcher
        // sees the approval even if the event fires synchronously.
        this.markFileAsUserApproved(newFilePath);

        let newFile;
        try {
            newFile = await this.app.vault.createBinary(newFilePath, arrayBuffer);
        } catch (e) {
            // If create failed, remove pre-approval immediately to avoid stale approvals.
            this.consumeUserApprovedUpload(newFilePath);
            throw e;
        }

        // Also approve the actual path in case vault normalized it differently
        if (newFile.path !== newFilePath) {
            this.markFileAsUserApproved(newFile.path);
        }

        // Record a simple placeholder keyed by file path and file name
        const placeholderText = `![[${newFile.name}]]`;
        const sourcePath = activeView.file?.path || "";
        this.recordPendingLinkPlaceholder(newFile.path, placeholderText, sourcePath);
        this.recordPendingLinkPlaceholder(newFile.name, placeholderText, sourcePath);

        // Insert a temporary wikilink to the local file so the eventual upload can replace it with the final URL
        activeView.editor.replaceSelection(placeholderText);

        // If autoUpload is disabled, upload directly; else watcher will trigger and replace the link
        if (!this.settings.autoUpload) {
            await this.handleImageUpload(newFile);
        }
    }

    async saveImageLocally(imageFile) {
        const arrayBuffer = await imageFile.arrayBuffer();
        const activeView = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
        if (!activeView) {
            new import_obsidian.Notice("Cannot save image: No active editor view.");
            return;
        }

        // Determine destination local-only folder (first of list or legacy field)
        const localOnlyFirst = (Array.isArray(this.settings.localOnlyList) && this.settings.localOnlyList.length > 0)
            ? (this.settings.localOnlyList[0]?.path || this.settings.localOnlyList[0] || '')
            : (this.settings.localImageFolder || 'notepix-local');
        // Normalize to a clean, vault-relative POSIX path
        const folderPath = (localOnlyFirst || 'notepix-local')
            .replace(/\\\\/g, "/")
            .replace(/^\/+|\/+$/g, "");
        // Ensure the folder exists
        try {
            await this.app.vault.createFolder(folderPath);
        } catch (e) {
            // Folder already exists, which is fine
        }

        const noteName = activeView.file ? activeView.file.basename : 'Untitled';
        const extension = imageFile.name.split('.').pop() || 'png';

        let i = 1;
        let newFilePath;
        do {
            newFilePath = `${folderPath}/${noteName}-${i}.${extension}`;
            i++;
        } while (await this.app.vault.adapter.exists(newFilePath));


        // Create the file in the vault at the determined path.
        const newFile = await this.app.vault.createBinary(newFilePath, arrayBuffer);

        // Insert the link to the newly created file.
        activeView.editor.replaceSelection(`![[${newFile.path}]]`);
    }  // New method to get the token, prompting for password if needed (encrypted mode).
    async getDecryptedToken() {
        if (this.decryptedToken) {
            return this.decryptedToken;
        }
        if (this.isPromptingForPassword) {
            return null;
        }
        if (this.settings.useEncryption && this.settings.encryptedToken) {
            this.isPromptingForPassword = true;
            try {
                const password = await new PasswordPrompt(this.app).open();
                const token = await decrypt(this.settings.encryptedToken, password);
                this.decryptedToken = token;
                return token;
            } catch (e) {
                const msg = String(e?.message || "");
                if (msg === "Password not provided") {
                    // User closed modal without entering password — no notice needed
                } else if (e?.name === 'OperationError' || /decryption|operation/i.test(msg)) {
                    new import_obsidian.Notice("Decryption failed. Incorrect password.", 5e3);
                } else {
                    new import_obsidian.Notice(`Decryption error: ${msg || 'Unknown error'}`, 5e3);
                }
                return null;
            } finally {
                this.isPromptingForPassword = false;
            }
        }
        return null;
    }

    // Unified token getter: returns a usable GitHub token based on settings/state.
    // - If a decrypted token is already cached in memory, returns it.
    // - If useEncryption is true, prompts (once) to decrypt encryptedToken when first needed.
    // - If useEncryption is false, returns the plainToken from settings (no prompts).
    async getToken() {
        // In-memory cache takes precedence
        if (this.decryptedToken) return this.decryptedToken;

        // Encrypted mode
        if (this.settings.useEncryption) {
            if (!this.settings.encryptedToken) {
                new import_obsidian.Notice("No encrypted token found. Please save an encrypted token in NotePix settings.");
                return null;
            }
            const token = await this.getDecryptedToken();
            return token;
        }

        // Plain mode
        if (this.settings.plainToken && this.settings.plainToken.trim().length > 0) {
            return this.settings.plainToken.trim();
        }
        new import_obsidian.Notice("No token found. Please provide a GitHub token in NotePix settings.");
        return null;
    }

    // --- Repo Privacy Detection (cached, 10-min TTL) ---
    async getRepoPrivacy() {
        const user = (this.settings.githubUser || '').trim();
        const repo = (this.settings.repoName || '').trim();
        if (!user || !repo) return "unknown";

        // Return cached value if still valid (10 min TTL, same user+repo)
        if (this.repoPrivacyCache &&
            this.repoPrivacyCache.user === user &&
            this.repoPrivacyCache.repo === repo &&
            (Date.now() - this.repoPrivacyCache.timestamp) < 10 * 60 * 1000) {
            return this.repoPrivacyCache.value;
        }

        // Need a token — don't trigger password prompt, only use what's available
        let token;
        if (this.decryptedToken) {
            token = this.decryptedToken;
        } else if (!this.settings.useEncryption && this.settings.plainToken) {
            token = this.settings.plainToken.trim();
        }
        if (!token) return "unknown";

        try {
            const response = await fetch(
                `https://api.github.com/repos/${encodeURIComponent(user)}/${encodeURIComponent(repo)}`,
                { headers: { "Authorization": `token ${token}`, "Accept": "application/vnd.github.v3+json" } }
            );
            if (!response.ok) return "unknown";
            const json = await response.json();
            const value = json.private ? "private" : "public";
            this.repoPrivacyCache = { value, timestamp: Date.now(), user, repo };
            return value;
        } catch (e) {
            console.error("NotePix: Failed to detect repo privacy:", e);
            return "unknown";
        }
    }

    clearRepoPrivacyCache() {
        this.repoPrivacyCache = null;
    }

    // Check whether a note contains raw GitHub image URLs owned by the configured user.
    // This intentionally allows any repo under that user while still restricting to
    // image-like paths to avoid unrelated raw GitHub links.
    containsConfiguredRepoRawImages(content) {
        if (!content) return false;
        const user = (this.settings.githubUser || '').trim();
        if (!user) return false;

        const ownerRe = escapeRegex(user);
        const rawConfiguredUserRegex = new RegExp(
            `raw\\.githubusercontent\\.com\\/${ownerRe}\\/[^\\s/]+\\/[^\\s)]+\\.(?:png|jpe?g|gif|bmp|svg|webp|avif)(?:\\?[^\\s)]*)?`,
            'i'
        );
        return rawConfiguredUserRegex.test(content);
    }

    // Repair malformed nested NotePix markdown URLs that can appear after partial replacements.
    // Example:
    // ![198]([obsidian://notepix/assets](obsidian://notepix/v2/<owner>/<repo>/<branch>/assets)/file.png)
    // -> ![198](obsidian://notepix/v2/<owner>/<repo>/<branch>/assets/file.png)
    sanitizeMalformedNotepixLinks(content) {
        if (!content || typeof content !== 'string') return content;
        const malformedNestedLink = /!\[([^\]]*)\]\(\[obsidian:\/\/notepix\/[^\]]*\]\((obsidian:\/\/notepix\/v2\/[^)]+)\)\/([^)]+)\)/g;
        return content.replace(malformedNestedLink, (_m, alt, base, tail) => {
            const safeAlt = String(alt || '');
            const cleanedBase = String(base || '').replace(/\/+$/, '');
            const cleanedTail = String(tail || '').replace(/^\/+/, '');
            return `![${safeAlt}](${cleanedBase}/${cleanedTail})`;
        });
    }

    async sanitizeFileOnOpen(file) {
        try {
            if (!file || !file.path || !file.path.endsWith('.md')) return;
            const content = await this.app.vault.read(file);
            const normalized = this.sanitizeMalformedNotepixLinks(content);
            if (normalized !== content) {
                await this.app.vault.modify(file, normalized);
                new import_obsidian.Notice("NotePix: Repaired malformed image link format in this note.", 4000);
            }
        } catch (e) {
            console.error("NotePix: sanitizeFileOnOpen error:", e);
        }
    }

    // Debounced mismatch check triggered on file-open (public mode only)
    checkRepoMismatchOnFileOpen(file) {
        if (this._fileOpenDebounceTimer) {
            clearTimeout(this._fileOpenDebounceTimer);
        }
        this._fileOpenDebounceTimer = setTimeout(async () => {
            try {
                if (!file || !file.path || !file.path.endsWith('.md')) return;
                // Mismatch prompting is only meaningful in forced public mode.
                if (this.settings.repoVisibility !== 'public') return;

                const content = await this.app.vault.read(file);
                if (!this.containsConfiguredRepoRawImages(content)) return;

                const privacy = await this.getRepoPrivacy();
                if (privacy !== 'private') return;

                // Prompt suppression: skip if same repo prompted within 24 hours
                const user = (this.settings.githubUser || '').trim();
                const repo = (this.settings.repoName || '').trim();
                const repoKey = `${user}/${repo}`;
                const lastAt = this.settings.lastPromptedAt || 0;
                const lastRepo = this.settings.lastPromptedRepo || '';
                const twentyFourHours = 24 * 60 * 60 * 1000;

                if (lastRepo === repoKey && (Date.now() - lastAt) < twentyFourHours) return;

                // Show 3-button mismatch modal
                const modal = new RepoMismatchModal(this.app, repoKey);
                const choice = await modal.openAndWait();

                // Persist prompt timestamp regardless of choice
                this.settings.lastPromptedAt = Date.now();
                this.settings.lastPromptedRepo = repoKey;

                if (choice === 'auto') {
                    this.settings.repoVisibility = 'auto';
                    new import_obsidian.Notice("NotePix: Auto mode enabled. Images will load via API for private repos.");
                } else if (choice === 'private') {
                    this.settings.repoVisibility = 'private';
                    new import_obsidian.Notice("NotePix: Switched to Private mode. Future uploads use private format.");
                } else if (choice === 'public') {
                    this.settings.repoVisibility = 'public';
                    new import_obsidian.Notice("NotePix: Keeping Public mode. Raw URLs may not load for private repos.");
                }
                // If choice is null (modal closed without picking), suppress for 24h anyway
                await this.saveSettings();
            } catch (e) {
                console.error("NotePix: Mismatch check error:", e);
            }
        }, 500);
    }

    async maybePromptRepoMismatch(repoKey) {
        const lastAt = this.settings.lastPromptedAt || 0;
        const lastRepo = this.settings.lastPromptedRepo || '';
        const twentyFourHours = 24 * 60 * 60 * 1000;
        if (lastRepo === repoKey && (Date.now() - lastAt) < twentyFourHours) {
            return null;
        }

        const modal = new RepoMismatchModal(this.app, repoKey);
        const choice = await modal.openAndWait();

        this.settings.lastPromptedAt = Date.now();
        this.settings.lastPromptedRepo = repoKey;

        if (choice === 'auto') {
            this.settings.repoVisibility = 'auto';
            new import_obsidian.Notice("NotePix: Auto mode enabled. Images will load via API for private repos.");
        } else if (choice === 'private') {
            this.settings.repoVisibility = 'private';
            new import_obsidian.Notice("NotePix: Switched to Private mode. Future uploads use private format.");
        } else if (choice === 'public') {
            this.settings.repoVisibility = 'public';
            new import_obsidian.Notice("NotePix: Keeping Public mode. Raw URLs may not load for private repos.");
        }
        await this.saveSettings();
        return choice;
    }

    // --- Optional extra: build a PUBLIC image URL (raw or jsDelivr CDN) ---
    // CDN is only valid for PUBLIC repos (jsDelivr can't serve private repos →
    // 404). Callers only reach this on the public/safe branches, but we pass the
    // detected privacy so 'auto' never emits a CDN link for a private repo.
    // Returns a raw URL unless useCdn is on AND the repo is known-public.
    buildPublicImageUrl(filePath, detectedPrivacy) {
        const user = this.settings.githubUser;
        const repo = this.settings.repoName;
        const branch = this.settings.branchName;
        // Encode path segments (spaces/unicode from byNotePath note names) while
        // preserving slashes, so the resulting URL is always valid (Option B).
        const encPath = this.encodeRepoPath(filePath);
        const rawUrl = `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${encPath}`;
        if (!this.settings.useCdn) return rawUrl;
        // Never emit CDN for a private (or unknown) repo — it would 404.
        if (detectedPrivacy === 'private' || detectedPrivacy === 'unknown') return rawUrl;
        return `https://cdn.jsdelivr.net/gh/${user}/${repo}@${branch}/${encPath}`;
    }

    // --- Optional extra: byNotePath storage ---
    // Clean one path segment WITHOUT changing the real name (Option B). We keep
    // the note's actual name (spaces, unicode, accents) — those are made URL-safe
    // by encodeRepoPath() at every URL build site. We only strip characters that
    // are illegal in a path segment / would break the slash structure:
    //   / \  (segment separators), and the leading/trailing dots & whitespace
    //   that are invalid as a folder name. Everything else is preserved verbatim.
    cleanRepoSegment(segment) {
        return String(segment || '')
            .replace(/[\\/]+/g, ' ')           // a slash inside a name can't be a separator
            .split('')
            .filter(ch => ch.charCodeAt(0) >= 32) // drop control characters
            .join('')
            .replace(/^[.\s]+|[.\s]+$/g, '')   // no leading/trailing dot or space
            .trim()
            || 'untitled';
    }

    // Decide the repo folder a given note's images go into.
    //  - global: settings.folderPath (current behavior)
    //  - byNotePath: byNotePathBaseFolder + the note's vault folder + note name,
    //    real names preserved. e.g. note "Projects/My Note.md" with base "assets"
    //    -> "assets/Projects/My Note" (the space survives; URLs encode it).
    //    A null/empty notePath falls back to the global folder so uploads never
    //    break when the note is unknown.
    getRepoFolderForNote(notePath) {
        const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if ((this.settings.imageStorageStrategy || 'global') !== 'byNotePath') {
            return norm(this.settings.folderPath || '');
        }
        const np = norm(notePath);
        if (!np) return norm(this.settings.folderPath || ''); // unknown note → safe fallback
        const base = norm(this.settings.byNotePathBaseFolder || 'assets')
            .split('/').map(s => this.cleanRepoSegment(s)).filter(Boolean).join('/');
        // Strip a trailing .md extension, then clean each folder + the note name.
        const noNoteExt = np.replace(/\.md$/i, '');
        const parts = noNoteExt.split('/').map(s => this.cleanRepoSegment(s)).filter(Boolean);
        return [base, ...parts].filter(Boolean).join('/');
    }

    // --- Optional extra: heading-text-based filenames ---
    // Turn a heading's text into a safe, readable filename slug. Keeps letters
    // (incl. unicode), digits; spaces/punctuation collapse to '-'. Trims edge
    // dashes. Empty/None → 'section'. (Encoding still applies at URL sites, but
    // a slug keeps names tidy and link-friendly.)
    slugifyHeading(text) {
        return String(text || '')
            .trim()
            .replace(/[\\/]+/g, '-')        // never introduce path separators
            .replace(/\s+/g, '-')           // spaces → dash
            .replace(/[^\p{L}\p{N}._-]+/gu, '-') // punctuation/symbols → dash (unicode letters kept)
            .replace(/-{2,}/g, '-')         // collapse repeats
            .replace(/^[.\-]+|[.\-]+$/g, '') // trim edge dot/dash
            || 'section';
    }

    // Next running counter for a (notePath | headingSlug) pair, persisted in
    // settings.imageCounters so numbering survives restarts. Saves asynchronously.
    async getNextHeadingCounter(notePath, headingSlug) {
        if (!this.settings.imageCounters || typeof this.settings.imageCounters !== 'object') {
            this.settings.imageCounters = {};
        }
        const key = `${notePath}|${headingSlug}`;
        const next = (this.settings.imageCounters[key] || 0) + 1;
        this.settings.imageCounters[key] = next;
        await this.saveSettings();
        return next;
    }

    // Build a heading-based filename for the image being pasted, e.g.
    // "Installation-1.png". Uses the heading whose start line is the last one at
    // or before the cursor (the section the cursor sits in). Returns null when
    // naming is off, there's no editor/cursor, or no heading precedes the cursor
    // — caller then falls back to the timestamp name.
    async generateHeadingBasedFileName(activeView, extension) {
        if (!this.settings.headingBasedNaming) return null;
        const file = activeView?.file;
        if (!file) return null;

        // Base name = the NOTE's name (always available). If the cursor sits under
        // a heading, refine it to "<note>-<heading>" for extra context. This means
        // a note "Untitled" with no headings still yields "Untitled-1.png" (never a
        // timestamp), which is what users expect.
        const noteSlug = this.slugifyHeading(file.basename || 'note');
        let baseSlug = noteSlug;

        const editor = activeView?.editor;
        if (editor && typeof editor.getCursor === 'function') {
            const cache = this.app.metadataCache.getFileCache(file);
            const headings = cache?.headings;
            if (Array.isArray(headings) && headings.length > 0) {
                const cursorLine = editor.getCursor().line;
                let current = null;
                for (let i = headings.length - 1; i >= 0; i--) {
                    const line = headings[i]?.position?.start?.line;
                    if (typeof line === 'number' && line <= cursorLine) { current = headings[i]; break; }
                }
                if (current) {
                    const headingSlug = this.slugifyHeading(current.heading);
                    if (headingSlug && headingSlug !== 'section') baseSlug = `${noteSlug}-${headingSlug}`;
                }
            }
        }

        const counter = await this.getNextHeadingCounter(file.path, baseSlug);
        return `${baseSlug}-${counter}.${extension}`;
    }

    async handleImageUpload(file, isPaste = false) {
        if (!this.settings.githubUser || !this.settings.repoName) {
            new import_obsidian.Notice("GitHub User and Repo Name must be configured.");
            return;
        }
        const token = await this.getToken();
        if (!token) return;
        const uploadNotice = new import_obsidian.Notice(`Uploading ${file.name} to GitHub...`, 0);
        try {
            const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
            // Optional heading-based name (e.g. "Installation-1.png"); else timestamp.
            const activeView = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
            const headingName = await this.generateHeadingBasedFileName(activeView, file.extension);
            const newFileName = headingName || `${timestamp}.${file.extension}`;
            const fileData = await (isPaste ? file.readBinary() : this.app.vault.readBinary(file));

            const base64Data = arrayBufferToBase64(fileData);
            // byNotePath: use the active note's path to derive the repo folder
            // (best-effort; falls back to global folder when unknown).
            const activeNotePath = activeView?.file?.path || '';
            const filePath = joinRepoPath(this.getRepoFolderForNote(activeNotePath), newFileName);
            const apiUrl = `https://api.github.com/repos/${this.settings.githubUser}/${this.settings.repoName}/contents/${this.encodeRepoPath(filePath)}`;
            const requestBody = {
                message: `feat: Add image '${newFileName}' from Obsidian`,
                content: base64Data,
                branch: this.settings.branchName
            };
            const response = await fetch(apiUrl, {
                method: "PUT",
                headers: {
                    "Authorization": `token ${token}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(requestBody)
            });
            uploadNotice.hide();
            if (!response.ok) {
                throw new Error(`GitHub API Error: ${(await response.json()).message}`);
            }

            let finalUrl;
            // Determine URL format based on repo visibility mode
            if (this.settings.repoVisibility === 'private') {
                // Private mode: self-describing format with owner/repo/branch embedded
                const encOwner = encodeURIComponent(this.settings.githubUser);
                const encRepo = encodeURIComponent(this.settings.repoName);
                const encBranch = encodeURIComponent(this.settings.branchName);
                const encPath = filePath.split('/').map(encodeURIComponent).join('/');
                finalUrl = `obsidian://notepix/v2/${encOwner}/${encRepo}/${encBranch}/${encPath}`;
                new import_obsidian.Notice("Private image link created.");
            } else if (this.settings.repoVisibility === 'auto') {
                // Auto mode: detect repo privacy and decide
                const detectedPrivacy = await this.getRepoPrivacy();
                if (detectedPrivacy === 'private') {
                    const encOwner = encodeURIComponent(this.settings.githubUser);
                    const encRepo = encodeURIComponent(this.settings.repoName);
                    const encBranch = encodeURIComponent(this.settings.branchName);
                    const encPath = filePath.split('/').map(encodeURIComponent).join('/');
                    finalUrl = `obsidian://notepix/v2/${encOwner}/${encRepo}/${encBranch}/${encPath}`;
                    new import_obsidian.Notice("Private repo detected. Private image link created.");
                } else {
                    // Public or unknown — use raw (or CDN if enabled & known-public).
                    finalUrl = this.buildPublicImageUrl(filePath, detectedPrivacy);
                    if (detectedPrivacy === 'unknown') {
                        new import_obsidian.Notice("Could not detect repo privacy. Using public URL as fallback.");
                    }
                }
            } else {
                // Public mode: standard raw GitHub URL, but if repo is actually private,
                // prompt user with the same 3-button mismatch modal.
                const detectedPrivacy = await this.getRepoPrivacy();
                if (detectedPrivacy === 'private') {
                    const repoKey = `${(this.settings.githubUser || '').trim()}/${(this.settings.repoName || '').trim()}`;
                    await this.maybePromptRepoMismatch(repoKey);
                }
                // Re-check: user may have switched visibility in the mismatch prompt
                if (this.settings.repoVisibility !== 'public' && detectedPrivacy === 'private') {
                    const encOwner = encodeURIComponent(this.settings.githubUser);
                    const encRepo = encodeURIComponent(this.settings.repoName);
                    const encBranch = encodeURIComponent(this.settings.branchName);
                    const encPath = filePath.split('/').map(encodeURIComponent).join('/');
                    finalUrl = `obsidian://notepix/v2/${encOwner}/${encRepo}/${encBranch}/${encPath}`;
                } else {
                    // Public (forced, and not detected private here) — raw or CDN.
                    finalUrl = this.buildPublicImageUrl(filePath, detectedPrivacy);
                }
            }

            let replacedLink = true;
            if (isPaste) {
                const activeView = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
                activeView?.editor.replaceSelection(`![](${finalUrl})`);
            } else {
                replacedLink = await this.replaceLinkInEditor(file.name, finalUrl, file.path);
                if (!replacedLink) {
                    new import_obsidian.Notice(`Could not find the placeholder link for ${file.name}. Local reference left untouched.`);
                }
            }

            new import_obsidian.Notice(`${newFileName} uploaded successfully!`);
            if (this.settings.deleteLocal && !isPaste && replacedLink) {
                await this.app.vault.delete(file);
                new import_obsidian.Notice(`Local file ${file.name} deleted.`);
            }
        } catch (error) {
            uploadNotice.hide();
            new import_obsidian.Notice(`Upload failed: ${error.message}`);
            console.error("GitHub Uploader Error:", error);
        }
    }

    // --- Issue #8: upload images ALREADY embedded in the current note ---
    // Design (verified against renmu123/obsidian-image-auto-upload-plugin and
    // addozhang/obsidian-image-upload-toolkit): collect every embedded local image
    // once, upload them ALL first while building a {source -> finalUrl} map, then do
    // exactly ONE write back to the note. No per-file editor rewrite, so the
    // race that clobbers earlier replacements cannot happen.
    //
    // Write target is the note captured at start (by file handle), not the live
    // visible editor — so the result lands in the correct note even if the user
    // switches away mid-upload. When that same note is still open and active, we
    // write through its editor to stay in sync with any live typing.

    // Upload one file and RETURN its final URL (no editor side effects).
    // linkMode is resolved once per batch so we never re-prompt mid-loop.
    // index keeps filenames unique within a single batch (timestamps alone can collide).
    async uploadSingleImageReturningUrl(file, token, linkMode, index = 0, notePath = "") {
        const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
        const suffix = index > 0 ? `-${index}` : "";
        const newFileName = `${timestamp}${suffix}.${file.extension}`;
        const fileData = await this.app.vault.readBinary(file);
        const base64Data = arrayBufferToBase64(fileData);
        const filePath = joinRepoPath(this.getRepoFolderForNote(notePath), newFileName);
        const apiUrl = `https://api.github.com/repos/${this.settings.githubUser}/${this.settings.repoName}/contents/${this.encodeRepoPath(filePath)}`;
        const requestBody = {
            message: `feat: Add image '${newFileName}' from Obsidian`,
            content: base64Data,
            branch: this.settings.branchName
        };
        const response = await fetch(apiUrl, {
            method: "PUT",
            headers: {
                "Authorization": `token ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(requestBody)
        });
        if (!response.ok) {
            let message = `HTTP ${response.status}`;
            try { message = (await response.json()).message || message; } catch (_) { }
            throw new Error(`GitHub API Error: ${message}`);
        }

        if (linkMode === 'private') {
            const encOwner = encodeURIComponent(this.settings.githubUser);
            const encRepo = encodeURIComponent(this.settings.repoName);
            const encBranch = encodeURIComponent(this.settings.branchName);
            const encPath = filePath.split('/').map(encodeURIComponent).join('/');
            return `obsidian://notepix/v2/${encOwner}/${encRepo}/${encBranch}/${encPath}`;
        }
        // linkMode 'raw' is only chosen for public/unknown repos by
        // resolveBatchLinkMode, so the repo is known-not-private here.
        return this.buildPublicImageUrl(filePath, 'public');
    }

    // Decide the link format for a whole batch, prompting at most once (mirrors
    // the single-upload logic in handleImageUpload, minus the per-file notices).
    async resolveBatchLinkMode() {
        if (this.settings.repoVisibility === 'private') return 'private';
        if (this.settings.repoVisibility === 'auto') {
            const detected = await this.getRepoPrivacy();
            return detected === 'private' ? 'private' : 'raw';
        }
        // Forced public mode: warn once if the repo is actually private.
        const detected = await this.getRepoPrivacy();
        if (detected === 'private') {
            const repoKey = `${(this.settings.githubUser || '').trim()}/${(this.settings.repoName || '').trim()}`;
            await this.maybePromptRepoMismatch(repoKey);
            if (this.settings.repoVisibility !== 'public') return 'private';
        }
        return 'raw';
    }

    // Scan a markdown snapshot for image embeds, both wikilink (![[...]]) and
    // markdown (![alt](url)) forms. Returns raw occurrences in document order:
    //   { source, isWiki, inner }            for wikilinks
    //   { source, isWiki, altRaw, urlRaw }    for markdown links
    // A hand-written scanner is used (not a single regex) so that filenames
    // containing parentheses — e.g. ![](my(file).png) — and <...>-wrapped URLs
    // are parsed correctly via balanced-paren tracking.
    parseImageEmbeds(content) {
        const out = [];
        if (!content) return out;
        const n = content.length;
        let i = 0;
        while (i < n) {
            const bang = content.indexOf('![', i);
            if (bang < 0) break;

            // Wikilink embed: ![[ ... ]]
            if (content[bang + 2] === '[') {
                const end = content.indexOf(']]', bang + 3);
                const inner = end >= 0 ? content.slice(bang + 3, end) : '';
                if (end < 0 || inner.includes('\n')) { i = bang + 2; continue; }
                out.push({ source: content.slice(bang, end + 2), isWiki: true, inner, from: bang, to: end + 2 });
                i = end + 2;
                continue;
            }

            // Markdown embed: ![alt](url) — alt then a parenthesised target.
            const altEnd = content.indexOf(']', bang + 2);
            const altRaw = altEnd >= 0 ? content.slice(bang + 2, altEnd) : '';
            if (altEnd < 0 || altRaw.includes('\n') || content[altEnd + 1] !== '(') {
                i = bang + 2;
                continue;
            }
            let j = altEnd + 2;
            let urlRaw = '';
            let fullEnd = -1;
            if (content[j] === '<') {
                // Angle-wrapped URL: read to '>', then the closing ')'.
                const gt = content.indexOf('>', j + 1);
                const close = gt >= 0 ? content.indexOf(')', gt + 1) : -1;
                if (gt < 0 || close < 0 || content.slice(j, close).includes('\n')) { i = altEnd + 1; continue; }
                urlRaw = content.slice(j, close);
                fullEnd = close + 1;
            } else {
                // Bare URL: walk forward, balancing parentheses so names with
                // ( ) are kept whole; stop at the parenthesis that closes the link.
                let depth = 1;
                let k = j;
                for (; k < n; k++) {
                    const c = content[k];
                    if (c === '\n') break;
                    if (c === '(') depth++;
                    else if (c === ')') { depth--; if (depth === 0) break; }
                }
                if (k >= n || content[k] !== ')') { i = altEnd + 1; continue; }
                urlRaw = content.slice(j, k);
                fullEnd = k + 1;
            }
            out.push({ source: content.slice(bang, fullEnd), isWiki: false, altRaw, urlRaw, from: bang, to: fullEnd });
            i = fullEnd;
        }
        return out;
    }

    // From a markdown link target, strip <...> wrapping and a trailing "title",
    // returning the bare path used to resolve the file.
    extractMarkdownLinkPath(urlRaw) {
        let linkPath = (urlRaw || '').trim();
        if (linkPath.startsWith('<') && linkPath.endsWith('>')) {
            linkPath = linkPath.slice(1, -1).trim();
        }
        const titleMatch = linkPath.match(/^(.*\S)\s+"[^"]*"$/);
        if (titleMatch) linkPath = titleMatch[1].trim();
        return linkPath;
    }

    // Convert a wikilink inner ("path|cap|200" / "path#heading") into:
    //   { linkPath }  the bare path used to resolve the file, and
    //   { alt }       the markdown alt text that preserves caption + size,
    //                 e.g. "cap|200", "|200", "my caption", or "".
    parseWikiInner(inner) {
        const parts = String(inner || '').split('|');
        const linkPath = (parts[0] || '').split('#')[0].trim();
        const sizeRe = /^\d+(?:x\d+)?$/;
        let size = '';
        const captions = [];
        for (const field of parts.slice(1)) {
            const f = field.trim();
            if (!f) continue;
            if (sizeRe.test(f)) size = f; // last size token wins (matches Obsidian)
            else captions.push(f);
        }
        const caption = captions.join(' ');
        let alt = caption;
        if (size) alt = caption ? `${caption}|${size}` : `|${size}`;
        return { linkPath, alt };
    }

    // Resolve image embeds to TFiles, preserving caption/size as markdown alt text.
    // Returns one entry per distinct source occurrence: { source, file, alt }.
    // `source` is the exact note text (replaced verbatim); `alt` is what to place
    // before the URL so ![caption|200](url) keeps the original display. Already
    // remote links (http/https/obsidian) and non-image targets are skipped.
    collectLocalImageEmbeds(content, activeFile) {
        const imageExtensions = ["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif"];
        const entries = [];
        const seenSources = new Set();

        for (const embed of this.parseImageEmbeds(content)) {
            const { source } = embed;
            if (!source || seenSources.has(source)) continue;

            let linkPath;
            let alt;
            if (embed.isWiki) {
                const parsed = this.parseWikiInner(embed.inner);
                linkPath = parsed.linkPath;
                alt = parsed.alt;
            } else {
                linkPath = this.extractMarkdownLinkPath(embed.urlRaw);
                alt = embed.altRaw; // already in caption|size form; keep verbatim
            }
            if (!linkPath) continue;

            const lower = linkPath.toLowerCase();
            if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('obsidian://')) {
                continue;
            }

            const decoded = (() => { try { return decodeURIComponent(linkPath); } catch (_) { return linkPath; } })();
            const dest = this.app.metadataCache.getFirstLinkpathDest(decoded, activeFile.path);
            if (!(dest instanceof import_obsidian.TFile)) continue;
            if (!imageExtensions.includes((dest.extension || '').toLowerCase())) continue;

            seenSources.add(source);
            entries.push({ source, file: dest, alt: alt || '' });
        }

        return entries;
    }

    async uploadAllLocalImagesInNote(activeFile) {
        if (!this.settings.githubUser || !this.settings.repoName) {
            new import_obsidian.Notice("GitHub User and Repo Name must be configured.");
            return;
        }
        if (!(activeFile instanceof import_obsidian.TFile) || !activeFile.path.endsWith('.md')) {
            new import_obsidian.Notice("Open a markdown note to upload its images.");
            return;
        }

        const token = await this.getToken();
        if (!token) return;

        // Snapshot the note from the live editor if it is the active note, else from disk.
        const startView = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
        const startFromEditor = !!(startView && startView.editor && startView.file && startView.file.path === activeFile.path);
        let snapshot;
        try {
            snapshot = startFromEditor ? startView.editor.getValue() : await this.app.vault.read(activeFile);
        } catch (e) {
            new import_obsidian.Notice("Could not read the note to scan for images.");
            console.error("NotePix: uploadAll read error:", e);
            return;
        }

        const entries = this.collectLocalImageEmbeds(snapshot, activeFile);
        if (entries.length === 0) {
            new import_obsidian.Notice("No local images found to upload in this note.");
            return;
        }

        // Upload each unique file once; map every occurrence-source to the resulting URL.
        const uniqueFiles = new Map();
        for (const entry of entries) {
            if (!uniqueFiles.has(entry.file.path)) uniqueFiles.set(entry.file.path, entry.file);
        }

        const linkMode = await this.resolveBatchLinkMode();
        const progress = new import_obsidian.Notice(`Uploading 0/${uniqueFiles.size} image(s)...`, 0);
        const urlByPath = new Map();
        let done = 0;
        let failed = 0;
        for (const [path, file] of uniqueFiles) {
            try {
                const url = await this.uploadSingleImageReturningUrl(file, token, linkMode, done + failed, activeFile?.path || "");
                urlByPath.set(path, url);
                done++;
            } catch (e) {
                failed++;
                console.error(`NotePix: failed to upload ${file.name}`, e);
                new import_obsidian.Notice(`Failed to upload ${file.name}: ${e.message}`, 6000);
            }
            progress.setMessage(`Uploading ${done + failed}/${uniqueFiles.size} image(s)...`);
        }
        progress.hide();

        if (urlByPath.size === 0) {
            new import_obsidian.Notice("No images were uploaded. Note left unchanged.");
            return;
        }

        // Build the single set of replacements (source text -> final markdown link).
        const replacements = [];
        const replacedFilePaths = new Set();
        for (const entry of entries) {
            const url = urlByPath.get(entry.file.path);
            if (!url) continue; // upload failed for this file; leave its link untouched
            // Preserve caption/size by carrying the original alt text through.
            replacements.push({ source: entry.source, replacement: `![${entry.alt || ''}](${url})` });
            replacedFilePaths.add(entry.file.path);
        }

        const applyReplacements = (text) => {
            if (!text) return { text, count: 0 };
            let out = text;
            let count = 0;
            for (const { source, replacement } of replacements) {
                if (!out.includes(source)) continue;
                out = out.split(source).join(replacement);
                count++;
            }
            return { text: out, count };
        };

        // ONE write back, to the note captured at start (by handle, not the visible screen).
        let wrote = false;
        const endView = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
        const sameNoteActive = !!(endView && endView.editor && endView.file && endView.file.path === activeFile.path);
        try {
            if (sameNoteActive) {
                // Stay in sync with any live typing: replace within the current editor value, write once.
                const editor = endView.editor;
                const current = editor.getValue();
                const result = applyReplacements(current);
                if (result.count > 0) {
                    const cursor = (typeof editor.getCursor === 'function') ? editor.getCursor() : null;
                    const scroll = (typeof editor.getScrollInfo === 'function') ? editor.getScrollInfo() : null;
                    editor.setValue(result.text);
                    if (scroll && typeof editor.scrollTo === 'function') {
                        try { editor.scrollTo(scroll.left, scroll.top); } catch (_) { }
                    }
                    if (cursor && typeof editor.setCursor === 'function') {
                        try { editor.setCursor(cursor); } catch (_) { }
                    }
                    wrote = true;
                }
            } else if (typeof this.app.vault.process === 'function') {
                // Not the active note: atomic read-modify-write straight to the file.
                let count = 0;
                await this.app.vault.process(activeFile, (data) => {
                    const result = applyReplacements(data);
                    count = result.count;
                    return result.text;
                });
                wrote = count > 0;
            } else {
                // Fallback for older app versions without vault.process.
                const data = await this.app.vault.read(activeFile);
                const result = applyReplacements(data);
                if (result.count > 0) {
                    await this.app.vault.modify(activeFile, result.text);
                    wrote = true;
                }
            }
        } catch (e) {
            console.error("NotePix: uploadAll write error:", e);
            new import_obsidian.Notice("Images uploaded, but updating the note failed. Links left unchanged.", 8000);
            return;
        }

        const summary = failed > 0
            ? `Uploaded ${done}/${uniqueFiles.size} image(s), ${failed} failed.`
            : `Uploaded ${done} image(s) and updated the note.`;
        new import_obsidian.Notice(summary);

        // Honor deleteLocal: only remove files whose link was actually replaced.
        if (this.settings.deleteLocal && wrote) {
            for (const [path, file] of uniqueFiles) {
                if (!replacedFilePaths.has(path)) continue;
                try {
                    await this.app.vault.delete(file);
                } catch (e) {
                    console.error(`NotePix: failed to delete local file ${path}`, e);
                }
            }
        }
    }

    // --- Issue #6: render private (v2) images in Live Preview (edit mode) ---
    // Reading View already renders them via postProcessImages. Live Preview never
    // runs markdown post-processors, so we add a CodeMirror editor extension that
    // detects obsidian://notepix/v2/... image embeds and renders each as an <img>
    // backed by the SAME in-memory blob cache used by Reading View. No temp files,
    // no disk writes; cache + revocation are already handled in onunload.

    // Return a non-prompting token usable for background image fetches.
    // Mirrors the hover-context rules in postProcessImages: never pops a password
    // modal here (editor rendering must stay silent).
    getRenderTokenNoPrompt() {
        if (this.decryptedToken) return this.decryptedToken;
        if (!this.settings.useEncryption) {
            return (this.settings.plainToken || '').trim() || null;
        }
        return null; // encrypted but not yet unlocked — caller skips rendering
    }

    // Resolve a v2 image (owner/repo/branch/path) to an in-memory blob URL,
    // reusing this.imageCache and this.failedImageFetches exactly like tryRepo()
    // in postProcessImages. Returns a blob URL string, or null on miss/failure.
    async resolveNotepixBlobUrl(owner, repo, branch, path, token) {
        if (!owner || !repo || !branch || !path || !token) return null;
        const cacheKey = `${owner}/${repo}/${branch}/${path}`.replace(/\\\\/g, "/");

        if (this.imageCache && this.imageCache.has(cacheKey)) {
            return this.imageCache.get(cacheKey);
        }
        const now = Date.now();
        const failTs = this.failedImageFetches.get(cacheKey) || 0;
        if (failTs && (now - failTs) < 30 * 1000) {
            return null;
        }

        const ref = encodeURIComponent(branch);
        const norm = path.replace(/\\\\/g, "/");
        const encSeg = (p) => p.split('/').map(encodeURIComponent).join('/');
        const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encSeg(norm)}?ref=${ref}`;

        try {
            let response = await fetch(apiUrl, {
                method: "GET",
                headers: { "Authorization": `token ${token}`, "Accept": "application/vnd.github.v3.raw" }
            });
            let imageBlob;
            if (response.ok) {
                imageBlob = await response.blob();
            } else {
                response = await fetch(apiUrl, {
                    method: "GET",
                    headers: { "Authorization": `token ${token}`, "Accept": "application/vnd.github.v3+json" }
                });
                if (!response.ok) { this.failedImageFetches.set(cacheKey, Date.now()); return null; }
                const meta = await response.json();
                if (!meta || !meta.content) { this.failedImageFetches.set(cacheKey, Date.now()); return null; }
                const raw = atob(meta.content.replace(/\n/g, ''));
                const bytes = new Uint8Array(raw.length);
                for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
                imageBlob = new Blob([bytes.buffer]);
            }
            const blobUrl = URL.createObjectURL(imageBlob);
            this.imageCache.set(cacheKey, blobUrl);
            this.failedImageFetches.delete(cacheKey);
            return blobUrl;
        } catch (_) {
            this.failedImageFetches.set(cacheKey, Date.now());
            return null;
        }
    }

    // Parse a single image-embed line target into v2 image components.
    // Accepts the raw URL/inner text from an embed and returns
    // { owner, repo, branch, path, alt } for v2 links, else null.
    // alt carries caption/size so the rendered <img> can be sized later if needed.
    parseNotepixV2Target(urlRaw, altRaw) {
        let url = (urlRaw || '').trim();
        if (url.startsWith('<') && url.endsWith('>')) url = url.slice(1, -1).trim();
        const titleMatch = url.match(/^(.*\S)\s+"[^"]*"$/);
        if (titleMatch) url = titleMatch[1].trim();
        if (!url.startsWith('obsidian://notepix/v2/')) return null;
        const after = url.substring('obsidian://notepix/v2/'.length);
        const parts = after.split('/');
        if (parts.length < 4) return null;
        const dec = (v) => { try { return decodeURIComponent(v); } catch (_) { return v; } };
        return {
            owner: dec(parts[0]),
            repo: dec(parts[1]),
            branch: dec(parts[2]),
            path: parts.slice(3).map(dec).join('/'),
            alt: altRaw || ''
        };
    }

    // --- Issue #7 foundation: canonicalize ANY NotePix image link/URL ---
    // Normalizes a link to { owner, repo, branch, path, kind } so that the same
    // image expressed as v2 / raw / jsDelivr-CDN / legacy compares equal (BP-7),
    // and so delete uses the repo+branch embedded in the LINK, never the
    // configured repo (BP-1, BP-18). Path is normalized (BP-15): decoded once,
    // leading/trailing slashes stripped, collapsed slashes. Returns null when the
    // link is not a NotePix-managed image, or { ambiguous:true } for legacy links
    // whose repo cannot be determined safely (BP-9).
    //
    // `legacyRepo` (optional) lets callers supply a resolved repo for legacy links
    // (e.g. from this.legacyResolvedRepoByKey); without it, legacy => ambiguous.
    canonicalizeImageRef(rawUrl, legacyRepo) {
        if (!rawUrl || typeof rawUrl !== 'string') return null;
        let url = rawUrl.trim();
        if (url.startsWith('<') && url.endsWith('>')) url = url.slice(1, -1).trim();
        const titleMatch = url.match(/^(.*\S)\s+"[^"]*"$/);
        if (titleMatch) url = titleMatch[1].trim();

        const dec = (v) => { try { return decodeURIComponent(v); } catch (_) { return v; } };
        const normPath = (p) => String(p || '')
            .replace(/\\/g, '/')
            .replace(/^\/+|\/+$/g, '')
            .replace(/\/{2,}/g, '/');

        // 1. v2 self-describing private link.
        if (url.startsWith('obsidian://notepix/v2/')) {
            const parts = url.substring('obsidian://notepix/v2/'.length).split('/');
            if (parts.length < 4) return null;
            const path = normPath(parts.slice(3).map(dec).join('/'));
            if (!path) return null;
            return { owner: dec(parts[0]), repo: dec(parts[1]), branch: dec(parts[2]), path, kind: 'v2' };
        }

        // 2. raw.githubusercontent.com/<owner>/<repo>/<branch>/<path...>
        //    Branch may contain slashes; prefer configured branch when it matches.
        const rawMatch = url.match(/^https?:\/\/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/(.+)$/i);
        if (rawMatch) {
            const owner = dec(rawMatch[1]);
            const repo = dec(rawMatch[2]);
            const rest = rawMatch[3];
            const cfgBranch = (this.settings.branchName || '').trim();
            let branch, path;
            if (cfgBranch && rest.startsWith(`${cfgBranch}/`)) {
                branch = cfgBranch;
                path = rest.substring(cfgBranch.length + 1);
            } else {
                const slash = rest.indexOf('/');
                if (slash <= 0) return null;
                branch = rest.substring(0, slash);
                path = rest.substring(slash + 1);
            }
            const np = normPath(dec(path));
            if (!owner || !repo || !branch || !np) return null;
            return { owner, repo, branch: dec(branch), path: np, kind: 'raw' };
        }

        // 3. jsDelivr CDN: cdn.jsdelivr.net/gh/<owner>/<repo>@<branch>/<path...>
        const cdnMatch = url.match(/^https?:\/\/cdn\.jsdelivr\.net\/gh\/([^\/]+)\/([^@\/]+)@([^\/]+)\/(.+)$/i);
        if (cdnMatch) {
            const owner = dec(cdnMatch[1]);
            const repo = dec(cdnMatch[2]);
            const branch = dec(cdnMatch[3]);
            const path = normPath(dec(cdnMatch[4]));
            if (!owner || !repo || !branch || !path) return null;
            return { owner, repo, branch, path, kind: 'cdn' };
        }

        // 4. Legacy private link: obsidian://notepix/<path> (no embedded repo).
        if (url.startsWith('obsidian://notepix/')) {
            const path = normPath(dec(url.substring('obsidian://notepix/'.length)));
            if (!path) return null;
            const owner = (this.settings.githubUser || '').trim();
            const branch = (this.settings.branchName || 'main').trim();
            const repo = (legacyRepo || '').trim();
            if (!owner || !repo) {
                // Cannot safely determine which repo holds this file (BP-9).
                return { ambiguous: true, owner, branch, path, kind: 'legacy' };
            }
            return { owner, repo, branch, path, kind: 'legacy' };
        }

        return null; // not a NotePix-managed image
    }

    // Stable comparison key for two canonical refs (BP-7). Path comparison is
    // case-SENSITIVE because GitHub paths are case-sensitive (BP-14).
    canonicalRefKey(ref) {
        if (!ref || ref.ambiguous) return null;
        return `${ref.owner}/${ref.repo}/${ref.branch}/${ref.path}`;
    }

    // Extract every NotePix-managed image URL string found in a markdown text.
    // Scans markdown image embeds AND bare obsidian://notepix / raw / cdn URLs so
    // links inside code spans or comments still count as references (BP-20).
    // Returns the raw URL strings (canonicalize separately).
    extractManagedUrlsFromMarkdown(text) {
        const urls = [];
        if (!text) return urls;
        // Bare URL patterns (also catches links inside `code`, %%comments%%, plain text).
        const patterns = [
            /obsidian:\/\/notepix\/v2\/[^\s)\]<>"']+/g,
            /obsidian:\/\/notepix\/(?!v2\/)[^\s)\]<>"']+/g,
            /https?:\/\/raw\.githubusercontent\.com\/[^\s)\]<>"']+/g,
            /https?:\/\/cdn\.jsdelivr\.net\/gh\/[^\s)\]<>"']+/g,
        ];
        for (const re of patterns) {
            let m;
            while ((m = re.exec(text)) !== null) {
                // Trim trailing punctuation that a URL regex may over-capture.
                urls.push(m[0].replace(/[)\].,;'">]+$/, ''));
            }
        }
        return urls;
    }

    // Extract NotePix-managed image URL strings referenced by a .canvas file (BP-16).
    // Canvas stores file nodes as { "type":"file", "file":"vault/path" } and text
    // nodes whose "text" may contain markdown image embeds. We scan both.
    extractManagedUrlsFromCanvas(jsonText) {
        const urls = [];
        if (!jsonText) return urls;
        let data;
        try { data = JSON.parse(jsonText); } catch (_) { return urls; }
        const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
        for (const node of nodes) {
            if (node && typeof node.text === 'string') {
                urls.push(...this.extractManagedUrlsFromMarkdown(node.text));
            }
            // A canvas "file" node usually points at a vault-local file, but if a
            // user pasted a managed URL as a file ref, capture it too.
            if (node && typeof node.file === 'string') {
                urls.push(...this.extractManagedUrlsFromMarkdown(node.file));
            }
        }
        return urls;
    }

    // Find every place in the vault (.md + .canvas) that references the given
    // canonical image ref. Returns [{ path, kind, count }]. Used by the multi-note
    // guard (BP-3) and orphan detection. Built by content-scan + canonicalization,
    // NOT metadataCache.resolvedLinks (which only tracks local links, not remote
    // URLs — BP-17). Optionally pass legacyRepoResolver(path)->repo for legacy links.
    async findImageReferencesInVault(targetRef, options = {}) {
        const targetKey = this.canonicalRefKey(targetRef);
        if (!targetKey) return [];
        const excludePath = options.excludePath || null;
        const results = [];

        const files = this.app.vault.getFiles
            ? this.app.vault.getFiles()
            : [];
        for (const file of files) {
            const ext = (file.extension || '').toLowerCase();
            const isMd = ext === 'md';
            const isCanvas = ext === 'canvas';
            if (!isMd && !isCanvas) continue;

            let content;
            try { content = await this.app.vault.read(file); } catch (_) { continue; }

            const urls = isCanvas
                ? this.extractManagedUrlsFromCanvas(content)
                : this.extractManagedUrlsFromMarkdown(content);
            if (urls.length === 0) continue;

            let count = 0;
            for (const url of urls) {
                const ref = this.canonicalizeImageRef(url);
                if (!ref || ref.ambiguous) continue;
                if (this.canonicalRefKey(ref) === targetKey) count++;
            }
            if (count > 0) {
                results.push({ path: file.path, kind: isCanvas ? 'canvas' : 'note', count });
            }
        }

        return options.includeSelf
            ? results
            : results.filter(r => r.path !== excludePath);
    }

    // --- Issue #7: GitHub delete engine ---
    // Encode a repo-relative path for the Contents API: each segment encoded,
    // slashes preserved (BP-15). Mirrors the encSeg used elsewhere.
    encodeRepoPath(path) {
        return String(path || '')
            .replace(/\\/g, '/')
            .replace(/^\/+|\/+$/g, '')
            .split('/')
            .map(encodeURIComponent)
            .join('/');
    }

    // Classify a fetch Response into a stable outcome the callers can branch on.
    // Distinguishes 404 (gone), 403 rate-limit vs permission, and other errors
    // (BP-5, BP-22, BP-24). Returns one of:
    //   'ok' | 'notFound' | 'rateLimited' | 'forbidden' | 'error'
    classifyGitHubResponse(response) {
        if (!response) return 'error';
        if (response.ok) return 'ok';
        if (response.status === 404) return 'notFound';
        if (response.status === 403) {
            const remaining = response.headers && typeof response.headers.get === 'function'
                ? response.headers.get('X-RateLimit-Remaining') : null;
            if (remaining === '0') return 'rateLimited';
            return 'forbidden';
        }
        return 'error';
    }

    // Fetch the current blob SHA for a file. Returns:
    //   { status:'ok', sha } | { status:'notFound' } | { status:'rateLimited' }
    //   | { status:'forbidden' } | { status:'error', message }
    // Always fetched fresh right before a delete to avoid stale-SHA 409s (BP-6).
    async getFileShaFromGitHub(owner, repo, branch, path, token) {
        const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${this.encodeRepoPath(path)}?ref=${encodeURIComponent(branch)}`;
        // Use Obsidian's requestUrl (not fetch): fetch().json() can fail on a 200
        // inside Obsidian's Electron runtime, which was causing "unreadable
        // response HTTP 200". requestUrl returns already-parsed JSON reliably.
        let response;
        try {
            response = await import_obsidian.requestUrl({
                url,
                method: 'GET',
                headers: { "Authorization": `token ${token}`, "Accept": "application/vnd.github.v3+json" },
                throw: false
            });
        } catch (e) {
            return { status: 'error', message: e?.message || 'network error' }; // BP-21
        }
        const status = response.status;
        if (status === 404) return { status: 'notFound', message: 'HTTP 404' };
        if (status === 403) {
            const remaining = response.headers && (response.headers['x-ratelimit-remaining'] ?? response.headers['X-RateLimit-Remaining']);
            return { status: remaining === '0' ? 'rateLimited' : 'forbidden', message: 'HTTP 403' };
        }
        if (status < 200 || status >= 300) return { status: 'error', message: `HTTP ${status}` };

        // CRITICAL: never touch response.json — in Obsidian it is a GETTER that
        // runs JSON.parse() on access and THROWS when the body is raw file bytes
        // (which is exactly what requestUrl returns for a Contents API file GET).
        // Work only from the raw arrayBuffer, which is always safe to read.
        let bytes = null;
        try {
            if (response.arrayBuffer) bytes = new Uint8Array(response.arrayBuffer);
        } catch (_) { bytes = null; }

        if (bytes && bytes.length) {
            // Peek at the first non-whitespace char to tell JSON from binary.
            let firstChar = '';
            for (let i = 0; i < bytes.length && i < 64; i++) {
                const c = bytes[i];
                if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
                firstChar = String.fromCharCode(c); break;
            }
            if (firstChar === '[') {
                return { status: 'error', message: 'path is a folder, not a file' };
            }
            if (firstChar === '{') {
                // JSON metadata — parse it for the sha.
                try {
                    const meta = JSON.parse(new TextDecoder().decode(bytes));
                    const jsonSha = meta && (meta.sha || (meta.content && meta.content.sha));
                    if (jsonSha) return { status: 'ok', sha: jsonSha };
                } catch (_) { /* fall through to blob-sha */ }
            }
            // Raw file bytes (the common Electron case): a GitHub file's sha IS its
            // git blob sha — SHA1("blob " + len + "\0" + bytes) — computed locally.
            try {
                const sha = await this.computeGitBlobSha(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
                if (sha) return { status: 'ok', sha };
            } catch (e) {
                console.error('NotePix: git blob sha computation failed', e);
            }
        }

        // Last resort: some builds expose only .text (a safe string, not a getter).
        try {
            if (typeof response.text === 'string' && response.text.trim().startsWith('{')) {
                const meta = JSON.parse(response.text);
                const jsonSha = meta && (meta.sha || (meta.content && meta.content.sha));
                if (jsonSha) return { status: 'ok', sha: jsonSha };
            }
        } catch (_) { /* ignore */ }

        return { status: 'error', message: `could not determine file sha (HTTP ${status})` };
    }

    // Compute a git blob SHA-1 from raw file bytes. This equals the `sha` GitHub
    // stores for a file, so it can be used directly in a Contents API delete.
    async computeGitBlobSha(arrayBuffer) {
        const bytes = new Uint8Array(arrayBuffer);
        const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
        const full = new Uint8Array(header.length + bytes.length);
        full.set(header, 0);
        full.set(bytes, header.length);
        const digest = await crypto.subtle.digest('SHA-1', full);
        return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // Delete a single file from GitHub. Re-fetches SHA right before deleting, and
    // retries ONCE on a 409 (stale SHA), per BP-6. Returns:
    //   { ok:true } | { ok:false, reason:'notFound'|'rateLimited'|'forbidden'|'error', message }
    // 404 on the SHA lookup is surfaced as 'notFound' so callers decide what it
    // means (delete-initiated => possible case mismatch BP-14; cleanup => already gone BP-5).
    async deleteFileFromGitHub(owner, repo, branch, path, token, _retried = false) {
        if (!owner || !repo || !branch || !path || !token) {
            return { ok: false, reason: 'error', message: 'missing parameters' };
        }
        const shaResult = await this.getFileShaFromGitHub(owner, repo, branch, path, token);
        if (shaResult.status !== 'ok') {
            return { ok: false, reason: shaResult.status, message: shaResult.message };
        }

        const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${this.encodeRepoPath(path)}`;
        // requestUrl (not fetch) for the same Electron-reliability reason as above.
        let response;
        try {
            response = await import_obsidian.requestUrl({
                url,
                method: "DELETE",
                headers: {
                    "Authorization": `token ${token}`,
                    "Content-Type": "application/json",
                    "Accept": "application/vnd.github.v3+json"
                },
                body: JSON.stringify({
                    message: `chore: Delete image '${path}' via NotePix`,
                    sha: shaResult.sha,
                    branch
                }),
                throw: false
            });
        } catch (e) {
            return { ok: false, reason: 'error', message: e?.message || 'network error' }; // BP-21
        }

        const status = response.status;
        if (status >= 200 && status < 300) return { ok: true };

        // 409 stale SHA — branch moved under us; re-fetch + retry once (BP-6).
        if (status === 409 && !_retried) {
            return this.deleteFileFromGitHub(owner, repo, branch, path, token, true);
        }

        let reason = 'error';
        if (status === 404) reason = 'notFound';
        else if (status === 403) {
            const remaining = response.headers && (response.headers['x-ratelimit-remaining'] ?? response.headers['X-RateLimit-Remaining']);
            reason = remaining === '0' ? 'rateLimited' : 'forbidden';
        }
        let message = `HTTP ${status}`;
        try { if (response.json && response.json.message) message = response.json.message; } catch (_) { }
        return { ok: false, reason, message };
    }

    // --- Issue #7: link removal + deletion orchestration ---
    // Remove every image embed in a file whose canonical ref matches targetRef.
    // Atomic via vault.process when available (BP-8), else read+modify with an
    // mtime guard so a concurrent edit doesn't get clobbered. Removes ALL matching
    // occurrences in the file (BP-19). Returns { ok, removed } (removed = count).
    async removeLinkOccurrencesFromFile(file, targetRef) {
        const targetKey = this.canonicalRefKey(targetRef);
        if (!targetKey || !file) return { ok: false, removed: 0 };

        const rewrite = (content) => {
            let removed = 0;
            const embeds = this.parseImageEmbeds(content);
            // Collect spans to remove (markdown embeds whose URL canonicalizes to target).
            const spans = [];
            for (const e of embeds) {
                if (e.isWiki) continue; // wikilinks don't carry managed remote URLs
                const ref = this.canonicalizeImageRef(e.urlRaw);
                if (!ref || ref.ambiguous) continue;
                if (this.canonicalRefKey(ref) === targetKey) {
                    spans.push({ from: e.from, to: e.to });
                }
            }
            if (spans.length === 0) return { text: content, removed: 0 };
            // Remove from the end backwards so earlier offsets stay valid.
            spans.sort((a, b) => b.from - a.from);
            let out = content;
            for (const s of spans) {
                out = out.slice(0, s.from) + out.slice(s.to);
                removed++;
            }
            // Tidy: collapse a line left entirely blank by the removal (BP-25),
            // without disturbing surrounding structure.
            out = out.replace(/[ \t]+\n/g, '\n');
            return { text: out, removed };
        };

        // Prefer atomic process (BP-8). Falls back to read+modify with mtime guard.
        try {
            if (typeof this.app.vault.process === 'function') {
                let removed = 0;
                await this.app.vault.process(file, (data) => {
                    const r = rewrite(data);
                    removed = r.removed;
                    return r.text;
                });
                return { ok: true, removed };
            }
            const startMtime = file.stat?.mtime || 0;
            const data = await this.app.vault.read(file);
            const r = rewrite(data);
            if (r.removed === 0) return { ok: true, removed: 0 };
            const latest = this.app.vault.getAbstractFileByPath(file.path);
            const latestMtime = (latest && latest.stat) ? (latest.stat.mtime || 0) : 0;
            if (startMtime && latestMtime && latestMtime !== startMtime) {
                return { ok: false, removed: 0, reason: 'changed' }; // BP-8/BP-23
            }
            await this.app.vault.modify(file, r.text);
            return { ok: true, removed: r.removed };
        } catch (e) {
            console.error('NotePix: removeLinkOccurrencesFromFile failed', e);
            return { ok: false, removed: 0, reason: 'error' };
        }
    }

    // Core deletion executor — TESTABLE (no modals). The caller has already
    // decided `scope`:
    //   'thisOnly' -> just unlink in sourceFile, never touch GitHub
    //   'all'      -> delete GitHub file, then unlink in sourceFile + everyLocation
    // sourceFile: the TFile the user acted in. otherLocations: results from
    // findImageReferencesInVault (excluding source). token: GitHub token.
    // Order (BP-4): for 'all', delete GitHub FIRST; only unlink after ok/notFound.
    // Guards double-run via an in-flight set keyed by canonical ref (BP-28).
    async executeImageDeletion(canonicalRef, sourceFile, otherLocations, token, scope) {
        if (canonicalRef && canonicalRef.ambiguous) {
            return { status: 'ambiguous' }; // BP-9 — caller should have warned already
        }
        const key = this.canonicalRefKey(canonicalRef);
        if (!key) return { status: 'error', message: 'invalid reference' };

        if (!this._deletionsInFlight) this._deletionsInFlight = new Set();
        if (this._deletionsInFlight.has(key)) return { status: 'inFlight' }; // BP-28
        this._deletionsInFlight.add(key);
        try {
            // thisOnly: never touch GitHub, just unlink locally.
            if (scope === 'thisOnly') {
                const r = await this.removeLinkOccurrencesFromFile(sourceFile, canonicalRef);
                return { status: r.ok ? 'unlinkedHere' : 'unlinkFailed', removed: r.removed };
            }

            // scope === 'all' — delete from GitHub first (BP-4).
            const del = await this.deleteFileFromGitHub(
                canonicalRef.owner, canonicalRef.repo, canonicalRef.branch, canonicalRef.path, token
            );
            // 404 in an explicit "delete" action may be a case mismatch (BP-14) —
            // report it rather than silently treating as success.
            if (!del.ok && del.reason === 'notFound') {
                return { status: 'githubNotFound' };
            }
            if (!del.ok) {
                return { status: 'githubFailed', reason: del.reason, message: del.message };
            }

            // GitHub delete succeeded — now unlink from source + all other locations.
            const targets = [sourceFile, ...(otherLocations || []).map(l =>
                this.app.vault.getAbstractFileByPath(l.path)).filter(Boolean)];
            let totalRemoved = 0;
            const unlinkFailures = [];
            for (const f of targets) {
                if (!f) continue;
                const r = await this.removeLinkOccurrencesFromFile(f, canonicalRef);
                if (r.ok) totalRemoved += r.removed;
                else unlinkFailures.push(f.path);
            }
            return {
                status: 'deleted',
                removed: totalRemoved,
                unlinkFailures, // GitHub gone but these notes couldn't be updated (rare)
            };
        } finally {
            this._deletionsInFlight.delete(key);
        }
    }

    // Given a single line of text and a cursor column, return the managed image
    // embed under the cursor (BP-10) — or, if the cursor isn't on one, the only
    // managed embed on the line. Returns { source, urlRaw } | null. A null cursor
    // column falls back to "single managed embed on the line, else null".
    findManagedEmbedOnLine(lineText, cursorCh) {
        const embeds = this.parseImageEmbeds(lineText).filter(e => {
            if (e.isWiki) return false;
            const ref = this.canonicalizeImageRef(e.urlRaw);
            return !!ref; // managed (incl. ambiguous legacy — caller handles BP-9)
        });
        if (embeds.length === 0) return null;
        if (typeof cursorCh === 'number') {
            const hit = embeds.find(e => cursorCh >= e.from && cursorCh <= e.to);
            if (hit) return { source: hit.source, urlRaw: hit.urlRaw, from: hit.from, to: hit.to };
        }
        // No cursor hit: only act if unambiguous (exactly one on the line).
        return embeds.length === 1
            ? { source: embeds[0].source, urlRaw: embeds[0].urlRaw, from: embeds[0].from, to: embeds[0].to }
            : null;
    }

    // Full right-click delete flow (live-tested): resolve the embed under the
    // cursor, canonicalize, run the multi-note guard, show the appropriate modal,
    // then call executeImageDeletion. Reports results via Notice.
    async handleDeleteImageAtCursor(editor, view) {
        const file = view?.file;
        if (!file) { new import_obsidian.Notice("No active note."); return; }
        const cursor = editor.getCursor();
        const lineText = editor.getLine(cursor.line);
        const found = this.findManagedEmbedOnLine(lineText, cursor.ch);
        if (!found) { new import_obsidian.Notice("No NotePix image found at the cursor."); return; }

        // Resolve repo for legacy links if possible (BP-9).
        let ref = this.canonicalizeImageRef(found.urlRaw);
        if (ref && ref.ambiguous) {
            // Try resolved-legacy cache; otherwise refuse with a clear modal.
            const legacyRepo = this.legacyResolvedRepoByKey
                ? this.legacyResolvedRepoByKey.get(`${ref.owner}|${ref.branch}|${ref.path}`) : null;
            if (legacyRepo) ref = this.canonicalizeImageRef(found.urlRaw, legacyRepo);
        }
        if (!ref) { new import_obsidian.Notice("Could not understand this image link."); return; }
        await this.deleteImageByRef(ref, file);
    }

    // Shared single-image delete flow used by BOTH the editor right-click (on the
    // link text) and the rendered-image right-click. Runs the multi-note guard,
    // shows the right modal, executes, and reports. `file` is the note to unlink
    // from (best-effort: the active note).
    async deleteImageByRef(ref, file) {
        if (!ref) { new import_obsidian.Notice("Could not understand this image link."); return; }
        if (ref.ambiguous) {
            await new ConfirmationModal(this.app, "Can't determine the GitHub file",
                "This is a legacy link without repository info, so NotePix can't safely tell which GitHub file to delete. Open the image once so it resolves, then try again.").open();
            return;
        }
        if (!file) {
            const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
            file = view?.file || null;
        }
        if (!file) { new import_obsidian.Notice("No active note to update."); return; }

        const token = await this.getToken();
        if (!token) return; // getToken already notifies

        const refLabel = `${ref.owner}/${ref.repo}/${ref.branch}/${ref.path}`;
        const others = await this.findImageReferencesInVault(ref, { excludePath: file.path });

        let scope;
        if (others.length > 0) {
            scope = await new MultiNoteDeleteModal(this.app, refLabel, others).openAndWait();
        } else {
            const ok = await new DeleteImageModal(this.app, refLabel).openAndWait();
            scope = ok ? 'all' : 'cancel';
        }
        if (scope === 'cancel') return;

        const res = await this.executeImageDeletion(ref, file, others, token, scope);
        switch (res.status) {
            case 'unlinkedHere':
                new import_obsidian.Notice("Removed the image link from this note."); break;
            case 'deleted': {
                let msg = `Deleted image from GitHub and removed ${res.removed} link(s).`;
                if (res.unlinkFailures && res.unlinkFailures.length) {
                    msg += ` Couldn't update: ${res.unlinkFailures.join(', ')}.`;
                }
                new import_obsidian.Notice(msg); break;
            }
            case 'githubNotFound':
                new import_obsidian.Notice("File not found on GitHub (it may already be deleted, or the path case differs). Link left untouched.", 7000); break;
            case 'githubFailed': {
                const why = res.reason === 'rateLimited' ? "GitHub rate limit reached — try again later."
                    : res.reason === 'forbidden' ? "Your token can't delete files (needs repo / contents:write)."
                    : `GitHub delete failed: ${res.message || res.reason}`;
                new import_obsidian.Notice(why, 8000); break;
            }
            case 'inFlight':
                new import_obsidian.Notice("Already deleting this image."); break;
            case 'unlinkFailed':
                new import_obsidian.Notice("Could not update the note (it may have changed). Nothing deleted."); break;
            default:
                new import_obsidian.Notice("Delete did not complete.");
        }
    }

    // --- Issue #7: multi-select delete (checklist of this note's images) ---
    // List the DISTINCT managed images embedded in a note's text. Returns
    // [{ ref, key, refLabel, displayName, count }] — one per unique GitHub file,
    // with how many times it appears in this note. Pure/testable.
    collectManagedImagesInNote(content) {
        const byKey = new Map();
        for (const embed of this.parseImageEmbeds(content)) {
            if (embed.isWiki) continue;
            let ref = this.canonicalizeImageRef(embed.urlRaw);
            if (!ref) continue;
            // Resolve legacy links via cache when possible; skip if still ambiguous.
            if (ref.ambiguous) {
                const legacyRepo = this.legacyResolvedRepoByKey
                    ? this.legacyResolvedRepoByKey.get(`${ref.owner}|${ref.branch}|${ref.path}`) : null;
                if (legacyRepo) ref = this.canonicalizeImageRef(embed.urlRaw, legacyRepo);
            }
            const key = this.canonicalRefKey(ref);
            if (!key) continue; // ambiguous/unusable
            const existing = byKey.get(key);
            if (existing) { existing.count++; continue; }
            byKey.set(key, {
                ref, key,
                refLabel: `${ref.owner}/${ref.repo}/${ref.branch}/${ref.path}`,
                displayName: ref.path.split('/').pop() || ref.path,
                count: 1
            });
        }
        return Array.from(byKey.values());
    }

    // Bulk-delete a chosen set of images from the current note (+ GitHub), with a
    // single up-front multi-note guard decision. `items` are entries from
    // collectManagedImagesInNote. `sharedChoice` decides what to do with images
    // still used elsewhere: 'skipShared' (delete only note-exclusive) or
    // 'deleteEverywhere' (remove from all notes + GitHub). Sequential (BP-6).
    async bulkDeleteImages(file, items, token, sharedChoice) {
        let deleted = 0, skipped = 0, failed = 0;
        const failMessages = [];
        const progress = new import_obsidian.Notice(`Deleting 0/${items.length}...`, 0);
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const others = await this.findImageReferencesInVault(item.ref, { excludePath: file.path });
            let scope;
            if (others.length > 0) {
                if (sharedChoice === 'skipShared') { skipped++; progress.setMessage(`Deleting ${i + 1}/${items.length}...`); continue; }
                scope = 'all'; // deleteEverywhere
            } else {
                scope = 'all';
            }
            const res = await this.executeImageDeletion(item.ref, file, others, token, scope);
            if (res.status === 'deleted') deleted++;
            else if (res.status === 'githubFailed' && res.reason === 'rateLimited') {
                progress.hide();
                new import_obsidian.Notice(`Stopped: GitHub rate limit reached after ${deleted} deletion(s). Try again later.`, 8000);
                return;
            } else {
                failed++;
                if (res.message) failMessages.push(`${item.displayName}: ${res.message}`);
            }
            progress.setMessage(`Deleting ${i + 1}/${items.length}...`);
        }
        progress.hide();
        let summary = `Deleted ${deleted} image(s).`;
        if (skipped) summary += ` Skipped ${skipped} still used elsewhere.`;
        if (failed) summary += ` ${failed} failed.`;
        new import_obsidian.Notice(summary, failed ? 8000 : 4000);
        if (failMessages.length) console.error('NotePix: bulk delete failures:', failMessages);
    }

    // Command entry: present a checklist of this note's images, then bulk-delete.
    async openMultiDeleteForActiveNote() {
        const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
        const file = view?.file;
        if (!file || !file.path.endsWith('.md')) { new import_obsidian.Notice("Open a markdown note first."); return; }
        let content;
        try {
            content = (view.editor && typeof view.editor.getValue === 'function')
                ? view.editor.getValue() : await this.app.vault.read(file);
        } catch (_) { new import_obsidian.Notice("Could not read the note."); return; }

        const items = this.collectManagedImagesInNote(content);
        if (items.length === 0) { new import_obsidian.Notice("No NotePix images found in this note."); return; }
        new MultiDeleteModal(this.app, this, file, items).open();
    }

    // --- Issue #7: find-orphans (report-only) ---
    // Folders NotePix is configured to manage in the repo. Returns normalized,
    // slash-free folder prefixes. Reads imageStorageStrategy so it stays correct
    // when the byNotePath extra is added later (BP-26); today only folderPath.
    getManagedRepoFolders() {
        const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        const folders = new Set();
        const strategy = this.settings.imageStorageStrategy || 'global';
        if (strategy === 'byNotePath' && this.settings.byNotePathBaseFolder) {
            folders.add(norm(this.settings.byNotePathBaseFolder));
        }
        // Always include the global folder (it's the default upload target).
        folders.add(norm(this.settings.folderPath || ''));
        return Array.from(folders).filter(f => f.length > 0);
    }

    // List image files in the configured repo under the managed folders, with
    // pagination via the Git Trees API (BP-12). Returns [{ path, owner, repo, branch }].
    async listRepoImagesUnderFolders(token) {
        const owner = (this.settings.githubUser || '').trim();
        const repo = (this.settings.repoName || '').trim();
        const branch = (this.settings.branchName || 'main').trim();
        if (!owner || !repo || !token) return { ok: false, reason: 'config', images: [] };

        const folders = this.getManagedRepoFolders();
        const imageExt = /\.(png|jpe?g|gif|bmp|svg|webp|avif)$/i;
        // Recursive tree of the branch in one call (GitHub returns up to 100k entries).
        const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
        let response;
        try {
            response = await import_obsidian.requestUrl({
                url, method: 'GET',
                headers: { "Authorization": `token ${token}`, "Accept": "application/vnd.github.v3+json" },
                throw: false
            });
        } catch (e) {
            return { ok: false, reason: 'network', images: [] };
        }
        const st = response.status;
        if (st === 403) {
            const remaining = response.headers && (response.headers['x-ratelimit-remaining'] ?? response.headers['X-RateLimit-Remaining']);
            return { ok: false, reason: remaining === '0' ? 'rateLimited' : 'forbidden', images: [] };
        }
        if (st < 200 || st >= 300) return { ok: false, reason: st === 404 ? 'notFound' : 'error', images: [] };
        let data;
        try { data = response.json; } catch (_) { return { ok: false, reason: 'error', images: [] }; }
        const tree = Array.isArray(data?.tree) ? data.tree : [];
        const truncated = !!data?.truncated; // BP-12: surface if GitHub capped the listing

        const images = [];
        for (const entry of tree) {
            if (entry.type !== 'blob') continue;
            const path = entry.path || '';
            if (!imageExt.test(path)) continue;
            const managed = folders.length === 0 ? true : folders.some(f => path === f || path.startsWith(f + '/'));
            images.push({ path, owner, repo, branch, managed });
        }
        return { ok: true, images, truncated };
    }

    // Build the set of canonical keys referenced anywhere in the vault (.md + .canvas),
    // so orphan detection can diff against it (BP-11/17). One pass over all files.
    async buildReferencedKeySet() {
        const keys = new Set();
        const files = this.app.vault.getFiles ? this.app.vault.getFiles() : [];
        for (const file of files) {
            const ext = (file.extension || '').toLowerCase();
            const isMd = ext === 'md';
            const isCanvas = ext === 'canvas';
            if (!isMd && !isCanvas) continue;
            let content;
            try { content = await this.app.vault.read(file); } catch (_) { continue; }
            const urls = isCanvas ? this.extractManagedUrlsFromCanvas(content) : this.extractManagedUrlsFromMarkdown(content);
            for (const url of urls) {
                const ref = this.canonicalizeImageRef(url);
                const key = this.canonicalRefKey(ref);
                if (key) keys.add(key);
            }
        }
        return keys;
    }

    // Orphan detection (report-only). Returns repo images (managed-scope) whose
    // canonical key is referenced by NO note/canvas. Never deletes here (BP-11).
    async computeOrphanImages(token) {
        const listing = await this.listRepoImagesUnderFolders(token);
        if (!listing.ok) return { ok: false, reason: listing.reason, orphans: [] };
        const referenced = await this.buildReferencedKeySet();
        const orphans = [];
        for (const img of listing.images) {
            if (!img.managed) continue; // only propose managed-scope files (BP-26)
            const key = `${img.owner}/${img.repo}/${img.branch}/${img.path}`;
            if (!referenced.has(key)) orphans.push(img);
        }
        return { ok: true, orphans, truncated: listing.truncated };
    }

    // Command entry: compute orphans and (live) present them for review. The
    // computation is unit-tested; the review modal + actual deletion is live.
    async findOrphanImages() {
        if (!this.settings.githubUser || !this.settings.repoName) {
            new import_obsidian.Notice("GitHub User and Repo Name must be configured."); return;
        }
        const token = await this.getToken();
        if (!token) return;
        const notice = new import_obsidian.Notice("Scanning repository and vault for orphaned images...", 0);
        let result;
        try { result = await this.computeOrphanImages(token); }
        catch (e) { notice.hide(); console.error('NotePix: orphan scan failed', e); new import_obsidian.Notice("Orphan scan failed."); return; }
        notice.hide();
        if (!result.ok) {
            const why = result.reason === 'rateLimited' ? "GitHub rate limit reached — try again later."
                : result.reason === 'forbidden' ? "Your token can't read the repo tree."
                : result.reason === 'config' ? "Repository not configured."
                : `Could not list repo images (${result.reason}).`;
            new import_obsidian.Notice(why, 7000); return;
        }
        if (result.orphans.length === 0) {
            new import_obsidian.Notice("No orphaned images found — every managed image is still referenced."); return;
        }
        // Present for review; OrphanReviewModal handles per-item selection + deletion.
        new OrphanReviewModal(this.app, this, result.orphans, result.truncated).open();
    }

    // Delete a user-selected list of orphan images from GitHub, one at a time
    // (serialized to avoid 409 stale-SHA races — BP-6). Halts the batch on a rate
    // limit (BP-22). Orphans have no note links to remove (they're unreferenced).
    async deleteOrphansSequentially(orphans) {
        const token = await this.getToken();
        if (!token) return;
        let deleted = 0, failed = 0;
        const progress = new import_obsidian.Notice(`Deleting 0/${orphans.length}...`, 0);
        for (let i = 0; i < orphans.length; i++) {
            const o = orphans[i];
            const res = await this.deleteFileFromGitHub(o.owner, o.repo, o.branch, o.path, token);
            if (res.ok || res.reason === 'notFound') {
                deleted++;
            } else {
                failed++;
                if (res.reason === 'rateLimited') {
                    progress.hide();
                    new import_obsidian.Notice(`Stopped: GitHub rate limit reached after ${deleted} deletion(s). Try again later.`, 8000);
                    return;
                }
            }
            progress.setMessage(`Deleting ${i + 1}/${orphans.length}...`);
        }
        progress.hide();
        new import_obsidian.Notice(failed > 0
            ? `Deleted ${deleted} orphan(s), ${failed} failed.`
            : `Deleted ${deleted} orphaned image(s) from GitHub.`);
    }

    // --- Optional extra: convert image link FORMAT in note text ---
    // Rewrites managed image embeds in `content` to `targetFormat`:
    //   'cdn' -> jsDelivr CDN  | 'raw' -> raw.githubusercontent
    // Only converts between PUBLIC formats (raw <-> cdn). Private v2 links and
    // legacy links are left untouched (CDN/raw can't serve private repos).
    // Preserves the embed's alt text. Pure function → unit-testable.
    // Returns { text, converted } (converted = count).
    convertLinkFormatsInText(content, targetFormat) {
        if (!content) return { text: content, converted: 0 };
        const embeds = this.parseImageEmbeds(content);
        const edits = []; // { from, to, replacement }
        for (const e of embeds) {
            if (e.isWiki) continue;
            const ref = this.canonicalizeImageRef(e.urlRaw);
            if (!ref || ref.ambiguous) continue;
            // Only raw<->cdn are convertible public formats.
            if (ref.kind !== 'raw' && ref.kind !== 'cdn') continue;
            if (ref.kind === targetFormat) continue; // already in target format
            const encPath = ref.path.split('/').map(encodeURIComponent).join('/');
            let newUrl;
            if (targetFormat === 'cdn') {
                newUrl = `https://cdn.jsdelivr.net/gh/${ref.owner}/${ref.repo}@${ref.branch}/${encPath}`;
            } else if (targetFormat === 'raw') {
                newUrl = `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${ref.branch}/${encPath}`;
            } else {
                continue;
            }
            edits.push({ from: e.from, to: e.to, replacement: `![${e.altRaw || ''}](${newUrl})` });
        }
        if (edits.length === 0) return { text: content, converted: 0 };
        edits.sort((a, b) => b.from - a.from); // apply back-to-front
        let out = content;
        for (const ed of edits) out = out.slice(0, ed.from) + ed.replacement + out.slice(ed.to);
        return { text: out, converted: edits.length };
    }

    // Command entry: convert all managed image links in the active note to a
    // chosen public format. Atomic write (BP-8). Refuses CDN target for a
    // private/auto-private repo (jsDelivr can't serve private repos).
    async convertNoteLinkFormat(file, targetFormat) {
        if (!(file instanceof import_obsidian.TFile) || !file.path.endsWith('.md')) {
            new import_obsidian.Notice("Open a markdown note first."); return;
        }
        if (targetFormat === 'cdn') {
            const privacy = await this.getRepoPrivacy();
            if (privacy === 'private') {
                new import_obsidian.Notice("This repo is private — jsDelivr CDN can't serve private repos. Conversion to CDN cancelled.", 7000);
                return;
            }
        }
        let count = 0;
        try {
            if (typeof this.app.vault.process === 'function') {
                await this.app.vault.process(file, (data) => {
                    const r = this.convertLinkFormatsInText(data, targetFormat);
                    count = r.converted;
                    return r.text;
                });
            } else {
                const data = await this.app.vault.read(file);
                const r = this.convertLinkFormatsInText(data, targetFormat);
                count = r.converted;
                if (count > 0) await this.app.vault.modify(file, r.text);
            }
        } catch (e) {
            console.error("NotePix: convert link format failed", e);
            new import_obsidian.Notice("Could not convert links."); return;
        }
        new import_obsidian.Notice(count > 0
            ? `Converted ${count} image link(s) to ${targetFormat === 'cdn' ? 'jsDelivr CDN' : 'GitHub raw'}.`
            : "No convertible public image links found in this note.");
    }

    // Compute character ranges covered by fenced (``` ```) or indented code
    // blocks so v2 links shown as example text are not rendered as images.
    getCodeBlockRanges(docText) {
        const ranges = [];
        if (!docText) return ranges;
        const lines = docText.split('\n');
        let offset = 0;
        let fenceOpen = null; // { marker, start }
        for (const line of lines) {
            const lineStart = offset;
            const lineEnd = offset + line.length;
            const fenceMatch = line.match(/^\s*(```+|~~~+)/);
            if (fenceOpen) {
                if (fenceMatch && line.trim().startsWith(fenceOpen.marker[0])) {
                    ranges.push({ from: fenceOpen.start, to: lineEnd });
                    fenceOpen = null;
                }
            } else if (fenceMatch) {
                fenceOpen = { marker: fenceMatch[1], start: lineStart };
            }
            offset = lineEnd + 1; // account for the '\n'
        }
        if (fenceOpen) ranges.push({ from: fenceOpen.start, to: docText.length });
        return ranges;
    }

    // Find every notepix-v2 image embed in a document string. Returns occurrences
    // with absolute char offsets (from parseImageEmbeds) so the editor extension
    // can place widgets at the EXACT span — never via indexOf, which would
    // collapse duplicate identical links onto one range and overlap-crash CM6.
    //   { source, from, to, target }   where target is parseNotepixV2Target output.
    findNotepixV2Embeds(docText) {
        const out = [];
        const codeRanges = this.getCodeBlockRanges(docText);
        const inCode = (from, to) => codeRanges.some(r => from < r.to && to > r.from);
        for (const embed of this.parseImageEmbeds(docText)) {
            if (embed.isWiki) continue; // wikilinks can't carry an obsidian:// URL
            const target = this.parseNotepixV2Target(embed.urlRaw, embed.altRaw);
            if (!target) continue;
            if (inCode(embed.from, embed.to)) continue; // skip code-block examples
            out.push({ source: embed.source, from: embed.from, to: embed.to, target });
        }
        return out;
    }

    // Patch any notepix <img> elements inside a container by swapping their
    // obsidian://notepix/... src for a fetched blob URL. Reuses the SAME engine
    // as Reading View (resolveNotepixBlobUrl + imageCache). This is the approach
    // that works: instead of fighting Obsidian's native Live Preview embed
    // rendering with a replace-widget, we let Obsidian create the <img> and just
    // fix its src — exactly like postProcessImages does for Reading View.
    patchNotepixImagesIn(containerEl) {
        if (!containerEl || typeof containerEl.querySelectorAll !== 'function') return;
        const imgs = Array.from(containerEl.querySelectorAll('img'));
        const token = this.getRenderTokenNoPrompt();
        for (const img of imgs) {
            const src = img.getAttribute('src') || '';

            // Case 1: private notepix link → fetch bytes + swap src (needs token).
            if (src.startsWith('obsidian://notepix/')) {
                if (img.dataset && img.dataset.notepixPatched === '1') continue;
                if (!token) continue; // encrypted+locked → skip silently (no prompt)
                const after = src.substring('obsidian://notepix/'.length);
                let owner, repo, branch, path;
                if (after.startsWith('v2/')) {
                    const parts = after.substring(3).split('/');
                    if (parts.length < 4) continue;
                    const dec = (v) => { try { return decodeURIComponent(v); } catch (_) { return v; } };
                    owner = dec(parts[0]); repo = dec(parts[1]); branch = dec(parts[2]);
                    path = parts.slice(3).map(dec).join('/');
                } else {
                    owner = (this.settings.githubUser || '').trim();
                    repo = (this.settings.repoName || '').trim();
                    branch = (this.settings.branchName || 'main').trim();
                    try { path = decodeURIComponent(after); } catch (_) { path = after; }
                }
                if (img.dataset) img.dataset.notepixPatched = '1';
                // Keep the original link so right-click can delete it after src swap.
                this.attachImageContextMenu(img, src);
                this.resolveNotepixBlobUrl(owner, repo, branch, path, token)
                    .then((url) => { if (url) img.src = url; })
                    .catch(() => { /* leave broken img on failure */ });
                continue;
            }

            // Case 2: public raw/CDN image owned by us → don't touch src (it renders
            // natively), but attach our menu so Copy image / Copy URL / Delete work.
            if (src.startsWith('https://raw.githubusercontent.com/') || src.startsWith('https://cdn.jsdelivr.net/gh/')) {
                if (img.dataset && img.dataset.notepixMenu === '1') continue;
                const ref = this.canonicalizeImageRef(src);
                if (!ref || ref.ambiguous) continue; // not a NotePix-managed image
                this.attachImageContextMenu(img, src);
            }
        }
    }

    // Compute the public URL to offer under "Copy URL" for a canonical ref, or
    // null when the image isn't publicly usable (private repo → the URL wouldn't
    // load for anyone). Matches the note's format: CDN if enabled, else raw.
    // Uses the CACHED repo privacy only (never prompts / never network here).
    publicUrlForRef(ref) {
        if (!ref || ref.ambiguous) return null;
        // A v2 link is private-by-definition → no shareable public URL.
        if (ref.kind === 'v2' || ref.kind === 'legacy') return null;
        // For raw/cdn links, only offer if the repo is known-public. Use cached
        // privacy; if unknown, be safe and hide (avoid handing out a dead URL).
        const cache = this.repoPrivacyCache;
        const sameRepo = cache && cache.user === (this.settings.githubUser || '').trim()
            && cache.repo === (this.settings.repoName || '').trim();
        const privacy = sameRepo ? cache.value : 'unknown';
        // If the link points at the configured repo, only offer when it's known
        // PUBLIC. Private → hide (URL won't load); unknown → hide (be safe, don't
        // hand out a possibly-dead URL). Links to OTHER repos are assumed public
        // (they rendered natively as a plain <img>, which only works if public).
        const isConfiguredRepo = ref.owner === (this.settings.githubUser || '').trim()
            && ref.repo === (this.settings.repoName || '').trim();
        if (isConfiguredRepo && privacy !== 'public') return null;
        // Build the URL in the note's preferred format.
        const encPath = ref.path.split('/').map(encodeURIComponent).join('/');
        if (this.settings.useCdn) {
            return `https://cdn.jsdelivr.net/gh/${ref.owner}/${ref.repo}@${ref.branch}/${encPath}`;
        }
        return `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${ref.branch}/${encPath}`;
    }

    // Attach a right-click menu to a rendered NotePix <img>. Obsidian gives no
    // public way to APPEND to its native image menu (editor-menu doesn't fire for
    // a rendered image widget), so we show our own menu that reproduces the useful
    // actions: Copy image (always), Copy URL (public/CDN only — hidden for private
    // repos, whose URLs wouldn't load for anyone), and Delete.
    attachImageContextMenu(img, originalUrl) {
        if (!img || img.dataset?.notepixMenu === '1') return;
        if (img.dataset) img.dataset.notepixMenu = '1';
        img.addEventListener('contextmenu', (evt) => {
            let ref = this.canonicalizeImageRef(originalUrl);
            if (ref && ref.ambiguous) {
                const legacyRepo = this.legacyResolvedRepoByKey
                    ? this.legacyResolvedRepoByKey.get(`${ref.owner}|${ref.branch}|${ref.path}`) : null;
                if (legacyRepo) ref = this.canonicalizeImageRef(originalUrl, legacyRepo);
            }
            if (!ref) return; // not a managed image → let Obsidian's own menu show
            evt.preventDefault();
            evt.stopPropagation();
            const menu = new import_obsidian.Menu();
            // Copy image — reproduce the native action so it isn't lost.
            menu.addItem((item) => {
                item.setTitle("Copy image")
                    .setIcon("image")
                    .onClick(() => this.copyImageToClipboard(img, ref));
            });
            // Copy URL — only when the image is publicly reachable.
            const publicUrl = this.publicUrlForRef(ref);
            if (publicUrl) {
                menu.addItem((item) => {
                    item.setTitle("Copy URL")
                        .setIcon("link")
                        .onClick(async () => {
                            try { await navigator.clipboard.writeText(publicUrl); new import_obsidian.Notice("Image URL copied."); }
                            catch (_) { new import_obsidian.Notice("Could not copy URL."); }
                        });
                });
            }
            menu.addSeparator?.();
            menu.addItem((item) => {
                item.setTitle("NotePix: Delete image (GitHub + note)")
                    .setIcon("trash")
                    .onClick(() => this.deleteImageByRef(ref, null));
            });
            menu.showAtMouseEvent(evt);
        });
    }

    // Fetch the real image BYTES for a canonical ref, reusing the same auth path
    // as rendering. Returns { arrayBuffer, contentType } or null. Works for both
    // private (needs token) and public repos (token optional but fine to send).
    async fetchImageBytes(ref) {
        if (!ref || ref.ambiguous) return null;
        const token = this.getRenderTokenNoPrompt() || (await this.getToken().catch(() => null));
        if (!token) return null;
        const encSeg = ref.path.split('/').map(encodeURIComponent).join('/');
        const url = `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/contents/${encSeg}?ref=${encodeURIComponent(ref.branch)}`;
        try {
            const resp = await import_obsidian.requestUrl({
                url, method: 'GET',
                headers: { "Authorization": `token ${token}`, "Accept": "application/vnd.github.v3.raw" },
                throw: false
            });
            if (resp.status < 200 || resp.status >= 300) return null;
            if (!resp.arrayBuffer) return null;
            // Guess content type from extension (GitHub raw doesn't always set it).
            const ext = (ref.path.split('.').pop() || '').toLowerCase();
            const contentType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
                : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp'
                : ext === 'svg' ? 'image/svg+xml' : ext === 'bmp' ? 'image/bmp' : 'image/png';
            return { arrayBuffer: resp.arrayBuffer, contentType };
        } catch (_) { return null; }
    }

    // Copy the actual image (bytes) to the clipboard — NOT the URL. Prefers
    // Electron's native clipboard.writeImage (handles cross-origin bytes cleanly
    // on desktop), then the Web ClipboardItem API. Only falls back to URL text as
    // a last resort, and says so explicitly.
    async copyImageToClipboard(img, ref) {
        const data = await this.fetchImageBytes(ref);
        // 1) Electron native clipboard (desktop) — most reliable for real bytes.
        try {
            if (data && !isMobile) {
                const electron = window.require ? window.require('electron') : null;
                const nativeImage = electron?.nativeImage;
                const clipboard = electron?.clipboard;
                if (nativeImage && clipboard) {
                    const buf = Buffer.from(new Uint8Array(data.arrayBuffer));
                    const image = nativeImage.createFromBuffer(buf);
                    if (image && !image.isEmpty()) {
                        clipboard.writeImage(image);
                        new import_obsidian.Notice("Image copied to clipboard.");
                        return;
                    }
                }
            }
        } catch (_) { /* fall through to web API */ }

        // 2) Web Clipboard API with the real bytes (works when ClipboardItem exists).
        try {
            if (data && navigator.clipboard && window.ClipboardItem) {
                // PNG is the most broadly-accepted type for image clipboard writes.
                const type = data.contentType === 'image/png' ? 'image/png' : data.contentType;
                const blob = new Blob([data.arrayBuffer], { type });
                await navigator.clipboard.write([new window.ClipboardItem({ [type]: blob })]);
                new import_obsidian.Notice("Image copied to clipboard.");
                return;
            }
        } catch (_) { /* fall through */ }

        // 3) Canvas from the already-rendered <img> (works for blob: srcs).
        try {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth || img.width;
            canvas.height = img.naturalHeight || img.height;
            if (canvas.width && canvas.height) {
                canvas.getContext('2d').drawImage(img, 0, 0);
                const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
                if (blob && navigator.clipboard && window.ClipboardItem) {
                    await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
                    new import_obsidian.Notice("Image copied to clipboard.");
                    return;
                }
            }
        } catch (_) { /* fall through */ }

        new import_obsidian.Notice("Could not copy the image bytes on this platform.", 6000);
    }

    // Build the Live-Preview editor extension. Returns null when CM6 view classes
    // are unavailable (older/unsupported environments); Reading View still works.
    // Strategy: a ViewPlugin that, whenever the editor updates, patches the src of
    // any obsidian://notepix images Obsidian rendered — plus a MutationObserver to
    // catch images added asynchronously as you scroll/type.
    buildLivePreviewExtension() {
        if (!cm6View || !cm6View.ViewPlugin) {
            return null;
        }
        const plugin = this;
        const { ViewPlugin } = cm6View;

        return ViewPlugin.fromClass(
            class {
                constructor(view) {
                    this.view = view;
                    // Patch what's already there.
                    plugin.patchNotepixImagesIn(view.dom);
                    // Watch for late-added images (scroll, live edits).
                    this.observer = new MutationObserver(() => {
                        plugin.patchNotepixImagesIn(view.dom);
                    });
                    this.observer.observe(view.dom, { childList: true, subtree: true });
                }
                update(u) {
                    if (u.docChanged || u.viewportChanged) {
                        plugin.patchNotepixImagesIn(u.view.dom);
                    }
                }
                destroy() {
                    if (this.observer) { this.observer.disconnect(); this.observer = null; }
                }
            }
        );
    }

    async postProcessImages(element, context) {
        this.isHandlingAction = true;
        try {
            const images = Array.from(element.querySelectorAll("img"));
            if (images.length === 0) return;

            const decodePathSafely = (value) => {
                if (!value || typeof value !== 'string') return value;
                try {
                    return decodeURIComponent(value);
                } catch (_) {
                    return value;
                }
            };
            const decodeSegmentSafely = (value) => {
                if (typeof value !== 'string') return '';
                try {
                    return decodeURIComponent(value);
                } catch (_) {
                    return value;
                }
            };

            // Recover malformed links like:
            // ![198]([obsidian://notepix/assets](obsidian://notepix/v2/.../assets)/file.png)
            // which can appear in DOM as an encoded app:// URL.
            const recoverMalformedNotepixSrc = (src) => {
                if (!src) return null;
                let candidate = src;
                if (candidate.startsWith("app://")) {
                    const idx = candidate.indexOf("%5Bobsidian://notepix/");
                    if (idx >= 0) {
                        try {
                            candidate = decodeURIComponent(candidate.substring(idx));
                        } catch (_) {
                            // Keep original candidate if decoding fails.
                        }
                    }
                }

                const malformed = candidate.match(/\[obsidian:\/\/notepix\/[^\]]*\]\((obsidian:\/\/notepix\/v2\/[^)]+)\)\/(.+)$/);
                if (!malformed) return null;
                const base = (malformed[1] || "").replace(/\/+$/, "");
                const tail = (malformed[2] || "").replace(/^\/+/, "");
                if (!base || !tail) return null;
                return `${base}/${tail}`;
            };

            const cfgUser = (this.settings.githubUser || '').trim();
            const cfgRepo = (this.settings.repoName || '').trim();

            // Match raw links from any repository owned by the configured user.
            // Example: https://raw.githubusercontent.com/<user>/<repo>/<branch>/<path>
            const rawSameUserRegex = cfgUser
                ? new RegExp(`^https:\\/\\/raw\\.githubusercontent\\.com\\/${escapeRegex(cfgUser)}\\/([^\\/]+)\\/(.+)$`, 'i')
                : null;

            // Categorize images into processable items
            const toProcess = [];
            const rawCandidates = [];
            for (const img of images) {
                let src = img.getAttribute("src");
                if (!src) continue;

                const recovered = recoverMalformedNotepixSrc(src);
                if (recovered) {
                    src = recovered;
                    img.setAttribute("src", recovered);
                }

                if (src.startsWith("obsidian://notepix/")) {
                    const afterPrefix = src.substring("obsidian://notepix/".length);
                    if (afterPrefix.startsWith("v2/")) {
                        // New self-describing format: v2/{owner}/{repo}/{branch}/{path}
                        const parts = afterPrefix.substring(3).split('/');
                        if (parts.length >= 4) {
                            toProcess.push({
                                img,
                                owner: decodeSegmentSafely(parts[0]),
                                repo: decodeSegmentSafely(parts[1]),
                                branch: decodeSegmentSafely(parts[2]),
                                path: parts.slice(3).map(decodeSegmentSafely).join('/'),
                                type: 'notepix-v2'
                            });
                        }
                    } else {
                        // Legacy format: use current settings
                        toProcess.push({
                            img,
                            owner: cfgUser,
                            repo: cfgRepo,
                            fallbackRepos: this.getLegacyRepoCandidates(cfgRepo),
                            branch: this.settings.branchName || 'main',
                            legacySrc: src,
                            // Legacy links can carry encoded segments (e.g. %20); decode once
                            // so API path encoding below does not double-encode.
                            path: decodePathSafely(afterPrefix),
                            type: 'notepix-legacy'
                        });
                    }
                } else if (rawSameUserRegex) {
                    const rawMatch = src.match(rawSameUserRegex);
                    if (rawMatch) {
                        const parsedRepo = decodeSegmentSafely(rawMatch[1] || '');
                        const repoRest = rawMatch[2] || '';
                        const slashIdx = repoRest.indexOf('/');
                        if (parsedRepo && slashIdx > 0) {
                            const configuredBranch = (this.settings.branchName || '').trim();
                            let branch = repoRest.substring(0, slashIdx);
                            let rawPath = repoRest.substring(slashIdx + 1);
                            // Branch names can contain slashes; prefer configured branch when it matches.
                            if (configuredBranch && repoRest.startsWith(`${configuredBranch}/`)) {
                                branch = configuredBranch;
                                rawPath = repoRest.substring(configuredBranch.length + 1);
                            }
                            rawCandidates.push({
                                img,
                                owner: cfgUser,
                                repo: parsedRepo,
                                branch,
                                // Raw URLs can include percent-encoded characters.
                                path: decodePathSafely(rawPath),
                                type: 'raw-fallback'
                            });
                        }
                    }
                }
            }

            // Raw fallback should apply to same-user raw links regardless of repo name.
            // This preserves rendering of older links from sibling repos while uploads still
            // target the currently configured repository.
            if (rawCandidates.length > 0) {
                toProcess.push(...rawCandidates);
            }

            if (toProcess.length === 0) return;

            // Token handling: avoid password prompt in hover popovers
            const hoverPopover = (this.app && this.app.renderContext)
                ? this.app.renderContext.hoverPopover : null;
            const isPopoverByAPI = !!hoverPopover;
            const activeLeaf = this.app.workspace.activeLeaf;
            const contextEl = context?.containerEl;
            const leafEl = activeLeaf?.containerEl;
            const isInActiveLeaf = !!(leafEl && contextEl && leafEl.contains(contextEl));
            // If we can't determine containment (missing DOM refs), assume active leaf
            // to avoid silently skipping image rendering in the main preview.
            const isHover = isPopoverByAPI || (contextEl ? !isInActiveLeaf : false);

            let token;
            if (isHover) {
                if (this.settings.useEncryption) {
                    token = this.decryptedToken;
                } else {
                    token = (this.settings.plainToken || '').trim() || null;
                }
                if (!token) return;
            } else {
                // In active preview (non-hover), allow one password prompt when encrypted token exists.
                // This restores expected behavior after app restart while still avoiding spam.
                if (this.settings.useEncryption) {
                    if (this.decryptedToken) {
                        token = this.decryptedToken;
                    } else if (this.settings.encryptedToken) {
                        token = await this.getToken();
                    } else {
                        token = null;
                    }
                } else {
                    token = (this.settings.plainToken || '').trim() || null;
                }
                if (!token) {
                    const now = Date.now();
                    if (!this._lastRenderTokenNoticeAt || (now - this._lastRenderTokenNoticeAt) > 30000) {
                        this._lastRenderTokenNoticeAt = now;
                        new import_obsidian.Notice("Token not unlocked/available. Private images render in preview after token is available.", 5000);
                    }
                    return;
                }
            }

            let configuredUserRepos = [];
            const hasLegacyLinks = toProcess.some(item => item?.type === 'notepix-legacy');
            if (hasLegacyLinks && cfgUser && token) {
                configuredUserRepos = await this.getConfiguredUserRepoList(token);
            }

            const encSeg = (p) => p.split('/').map(encodeURIComponent).join('/');
            const errorSvg = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWJhbiI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48bGluZSB4MT0iNC45MyIgeTE9IjQuOTMiIHgyPSIxOS4wNyIgeTI9IjE5LjA3Ii8+PC9zdmc+";
            let showedRawNotice = false;

            const fetchAndSet = async (item) => {
                const { img, owner, repo, branch, path, type } = item;
                let repoCandidates = [repo];
                if (type === 'notepix-legacy') {
                    const staticCandidates = Array.isArray(item.fallbackRepos) ? item.fallbackRepos : [];
                    const dynamicCandidates = Array.isArray(configuredUserRepos) ? configuredUserRepos : [];
                    const legacyKey = `${owner}|${branch}|${path}`;
                    const unresolvedUntil = this.legacyUnresolvedUntil.get(legacyKey) || 0;
                    if (Date.now() < unresolvedUntil) {
                        img.src = errorSvg;
                        return;
                    }
                    const resolvedRepo = this.legacyResolvedRepoByKey.get(legacyKey);
                    const ordered = [];
                    if (resolvedRepo) ordered.push(resolvedRepo);
                    ordered.push(...staticCandidates, ...dynamicCandidates);
                    repoCandidates = Array.from(new Set(ordered.filter(Boolean)));
                    if (repoCandidates.length === 0 && repo) repoCandidates = [repo];
                    // Hard cap to avoid excessive candidate scanning on very large accounts.
                    if (repoCandidates.length > 25) {
                        repoCandidates = repoCandidates.slice(0, 25);
                    }
                }

                const ref = encodeURIComponent(branch);
                const norm = path.replace(/\\\\/g, "/");

                const tryRepo = async (repoCandidate) => {
                    const cacheKey = `${owner}/${repoCandidate}/${branch}/${path}`.replace(/\\\\/g, "/");
                    const now = Date.now();
                    const failTs = this.failedImageFetches.get(cacheKey) || 0;
                    if (failTs && (now - failTs) < 30 * 1000) {
                        return null;
                    }

                    if (this.imageCache.has(cacheKey)) {
                        img.src = this.imageCache.get(cacheKey);
                        return repoCandidate;
                    }

                    const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoCandidate)}/contents/${encSeg(norm)}?ref=${ref}`;

                    try {
                        let response = await fetch(apiUrl, {
                            method: "GET",
                            headers: { "Authorization": `token ${token}`, "Accept": "application/vnd.github.v3.raw" }
                        });

                        let imageBlob;
                        if (response.ok) {
                            imageBlob = await response.blob();
                        } else {
                            // Fallback to JSON content API
                            response = await fetch(apiUrl, {
                                method: "GET",
                                headers: { "Authorization": `token ${token}`, "Accept": "application/vnd.github.v3+json" }
                            });
                            if (!response.ok) {
                                this.failedImageFetches.set(cacheKey, Date.now());
                                return null;
                            }
                            const meta = await response.json();
                            if (!meta || !meta.content) {
                                this.failedImageFetches.set(cacheKey, Date.now());
                                return null;
                            }
                            const raw = atob(meta.content.replace(/\n/g, ''));
                            const bytes = new Uint8Array(raw.length);
                            for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
                            imageBlob = new Blob([bytes.buffer]);
                        }

                        const blobUrl = URL.createObjectURL(imageBlob);
                        this.imageCache.set(cacheKey, blobUrl);
                        this.failedImageFetches.delete(cacheKey);
                        img.src = blobUrl;
                        return repoCandidate;
                    } catch (_) {
                        this.failedImageFetches.set(cacheKey, Date.now());
                        return null;
                    }
                };

                let resolvedRepo = null;
                for (const repoCandidate of repoCandidates) {
                    if (!repoCandidate) continue;
                    resolvedRepo = await tryRepo(repoCandidate);
                    if (resolvedRepo) break;
                }

                if (!resolvedRepo) {
                    if (type === 'notepix-legacy') {
                        const legacyKey = `${owner}|${branch}|${path}`;
                        this.legacyUnresolvedUntil.set(legacyKey, Date.now() + 5 * 60 * 1000);
                    }
                    img.src = errorSvg;
                    console.error(`NotePix: Failed to fetch image ${owner}/${repo}/${branch}/${path} from candidate repos.`);
                    return;
                }

                if (type === 'notepix-legacy') {
                    const legacyKey = `${owner}|${branch}|${path}`;
                    this.legacyResolvedRepoByKey.set(legacyKey, resolvedRepo);
                    this.legacyUnresolvedUntil.delete(legacyKey);
                }

                // Migrate legacy links only after a successful, concrete resolution.
                // No guessing: we only rewrite when an exact source path resolves from a known repo.
                if (type === 'notepix-legacy' && item.legacySrc && context?.sourcePath) {
                    const encOwner = encodeURIComponent(owner || '');
                    const encRepo = encodeURIComponent(resolvedRepo || '');
                    const encBranch = encodeURIComponent(branch || 'main');
                    const encPath = String(path || '').split('/').map(encodeURIComponent).join('/');
                    if (encOwner && encRepo && encBranch && encPath) {
                        const v2Url = `obsidian://notepix/v2/${encOwner}/${encRepo}/${encBranch}/${encPath}`;
                        this.queueLegacyLinkMigration(context.sourcePath, item.legacySrc, v2Url);
                    }
                }

                // Subtle notice for raw-fallback images (once per session)
                if (type === 'raw-fallback' && !showedRawNotice && !this._mismatchNoticeShown) {
                    this._mismatchNoticeShown = true;
                    showedRawNotice = true;
                    new import_obsidian.Notice("Repository is private. Old public images loaded via API in preview.", 5000);
                }
            };

            // Process all categorized images in parallel
            await Promise.allSettled(toProcess.map(item => fetchAndSet(item)));

            // Observe DOM for late-added notepix images
            const observer = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    for (const node of Array.from(m.addedNodes)) {
                        if (node.nodeType !== 1) continue;
                        const el = node;
                        const imgs = (el.matches && el.matches('img') ? [el]
                            : Array.from(el.querySelectorAll ? el.querySelectorAll('img') : []));
                        for (const addedImg of imgs) {
                            let src = addedImg.getAttribute('src');
                            if (!src) continue;
                            const recovered = recoverMalformedNotepixSrc(src);
                            if (recovered) {
                                src = recovered;
                                addedImg.setAttribute('src', recovered);
                            }
                            if (!src.startsWith('obsidian://notepix/')) continue;
                            const afterPrefix = src.substring("obsidian://notepix/".length);
                            if (afterPrefix.startsWith("v2/")) {
                                const parts = afterPrefix.substring(3).split('/');
                                if (parts.length >= 4) {
                                    fetchAndSet({
                                        img: addedImg,
                                        owner: decodeSegmentSafely(parts[0]),
                                        repo: decodeSegmentSafely(parts[1]),
                                        branch: decodeSegmentSafely(parts[2]),
                                        path: parts.slice(3).map(decodeSegmentSafely).join('/'),
                                        type: 'notepix-v2'
                                    });
                                }
                            } else {
                                fetchAndSet({
                                    img: addedImg,
                                    owner: cfgUser,
                                    repo: cfgRepo,
                                    branch: this.settings.branchName || 'main',
                                    path: decodePathSafely(afterPrefix),
                                    type: 'notepix-legacy'
                                });
                            }
                        }
                    }
                }
            });
            observer.observe(element, { childList: true, subtree: true });
            setTimeout(() => observer.disconnect(), 1500);
        } finally {
            this.isHandlingAction = false;
        }
    }

    // NEW: clean, filename-friendly replacement that also uses pending placeholders
    async replaceLinkInEditor(fileName, replacementTarget, originalPath = "", options = {}) {
        const replacementType = options?.replacementType || 'remote';
        const replacementText = replacementType === 'wiki'
            ? `![[${replacementTarget}]]`
            : (replacementType === 'raw' ? `${replacementTarget}` : `![](${replacementTarget})`);

        return new Promise((resolve) => {
            setTimeout(async () => {
                const normalizedPath = this.normalizeVaultPath(originalPath);
                const pendingByPath = this.peekPendingLinkPlaceholder(normalizedPath || fileName);
                const pendingByName = this.peekPendingLinkPlaceholder(fileName);
                const pendingEntry = pendingByPath || pendingByName;
                const sourcePathHint = this.normalizeVaultPath(options?.sourcePath || pendingEntry?.sourcePath || "");

                const buildReplacedContent = (content) => {
                    if (!content) return { replaced: false, newContent: content };

                    // Normalize malformed content that can appear from partial replacements:
                    // ![198]([obsidian://notepix/assets](obsidian://notepix/v2/.../assets)/file.png)
                    // -> ![198](obsidian://notepix/v2/.../assets/file.png)
                    const malformedNestedLink = /!\[([^\]]*)\]\(\[obsidian:\/\/notepix\/[^\]]*\]\((obsidian:\/\/notepix\/v2\/[^)]+)\)\/([^)]+)\)/g;
                    let normalizedContent = content.replace(malformedNestedLink, (_m, alt, base, tail) => {
                        const cleanedBase = String(base || '').replace(/\/+$/, '');
                        const cleanedTail = String(tail || '').replace(/^\/+/, '');
                        return `![${alt || ''}](${cleanedBase}/${cleanedTail})`;
                    });

                    const escapedFileName = fileName.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
                    const escapedPath = normalizedPath ? normalizedPath.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&") : null;

                    const replaceLastRegexMatch = (source, regex, replacement) => {
                        const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
                        const globalRegex = new RegExp(regex.source, flags);
                        let match;
                        let lastMatch = null;
                        while ((match = globalRegex.exec(source)) !== null) {
                            lastMatch = { index: match.index, text: match[0] };
                            if (match[0].length === 0) {
                                globalRegex.lastIndex += 1;
                            }
                        }
                        if (!lastMatch) {
                            return { replaced: false, value: source };
                        }
                        const before = source.slice(0, lastMatch.index);
                        const after = source.slice(lastMatch.index + lastMatch.text.length);
                        return { replaced: true, value: `${before}${replacement}${after}` };
                    };

                    const patterns = [];
                    // Wikilink by filename (Android attachments: ![[Screenshot_....jpg]])
                    patterns.push(new RegExp(`!\\[\\[(?:[^\\]|]*?/)*${escapedFileName}(?:\\|[^\\]]*)?\\]\\]`));
                    // Wikilink by normalized path if available
                    if (escapedPath) {
                        patterns.push(new RegExp(`!\\[\\[(?:[^\\]|]*?/)*${escapedPath}(?:\\|[^\\]]*)?\\]\\]`));
                    }
                    // Markdown image links by filename
                    patterns.push(new RegExp(`!\\[[^\\]]*\\]\\([^\\)]*${escapedFileName}[^\\)]*\\)`));
                    patterns.push(new RegExp(`!\\[[^\\]]*\\]\\([^\\)]*${encodeURIComponent(fileName)}[^\\)]*\\)`));
                    if (escapedPath) {
                        patterns.push(new RegExp(`!\\[[^\\]]*\\]\\([^\\)]*${escapedPath}[^\\)]*\\)`));
                        patterns.push(new RegExp(`!\\[[^\\]]*\\]\\([^\\)]*${encodeURIComponent(normalizedPath)}[^\\)]*\\)`));
                    }

                    let replaced = false;
                    let newContent = normalizedContent;

                    // First preference: replace the exact pending placeholder captured for this file.
                    // This is the most deterministic option when filenames repeat in the same note.
                    const fallbackPlaceholder = pendingEntry?.placeholderText || null;
                    if (fallbackPlaceholder && newContent.includes(fallbackPlaceholder)) {
                        const idx = newContent.lastIndexOf(fallbackPlaceholder);
                        if (idx >= 0) {
                            replaced = true;
                            newContent = `${newContent.slice(0, idx)}${replacementText}${newContent.slice(idx + fallbackPlaceholder.length)}`;
                        }
                    }

                    for (const regex of patterns) {
                        if (replaced) break;
                        if (!regex) continue;
                        const result = replaceLastRegexMatch(newContent, regex, replacementText);
                        replaced = result.replaced;
                        newContent = result.value;
                    }

                    // If normalization changed content, persist it even when no direct replacement was needed.
                    if (!replaced && newContent !== content) {
                        replaced = true;
                    }

                    return { replaced, newContent };
                };

                const activeView = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
                const activeFilePath = this.normalizeVaultPath(activeView?.file?.path || "");
                const canUseActiveEditor = !!(activeView && activeView.editor && (!sourcePathHint || sourcePathHint === activeFilePath));

                if (canUseActiveEditor) {
                    const editor = activeView.editor;
                    const doc = (typeof editor.getDoc === 'function') ? editor.getDoc() : null;
                    let content = '';
                    if (doc?.getValue) {
                        try { content = doc.getValue(); } catch (_) { content = ''; }
                    }
                    if (!content && typeof editor.getValue === 'function') {
                        try { content = editor.getValue(); } catch (_) { content = ''; }
                    }

                    const result = buildReplacedContent(content);
                    if (result.replaced) {
                        const cursor = (typeof editor.getCursor === 'function') ? editor.getCursor() : null;
                        let wrote = false;
                        if (doc?.setValue) {
                            try { doc.setValue(result.newContent); wrote = true; } catch (_) { wrote = false; }
                        }
                        if (!wrote && typeof editor.setValue === 'function') {
                            try { editor.setValue(result.newContent); wrote = true; } catch (_) { wrote = false; }
                        }
                        if (cursor && typeof editor.setCursor === 'function') {
                            try { editor.setCursor(cursor); } catch (_) { }
                        }
                        if (wrote) {
                            if (pendingByPath) this.consumePendingLinkPlaceholder(pendingByPath.key);
                            if (pendingByName) this.consumePendingLinkPlaceholder(pendingByName.key);
                            return resolve(true);
                        }
                    }
                }

                // Fallback: apply replacement directly to the source note file if known.
                if (sourcePathHint) {
                    try {
                        const target = this.app.vault.getAbstractFileByPath(sourcePathHint);
                        if (target instanceof import_obsidian.TFile && target.path.endsWith('.md')) {
                            const startMtime = target.stat?.mtime || 0;
                            const content = await this.app.vault.read(target);
                            const result = buildReplacedContent(content);
                            if (!result.replaced) {
                                return resolve(false);
                            }
                            const latest = this.app.vault.getAbstractFileByPath(sourcePathHint);
                            const latestMtime = (latest instanceof import_obsidian.TFile) ? (latest.stat?.mtime || 0) : 0;
                            if (startMtime && latestMtime && latestMtime !== startMtime) {
                                return resolve(false);
                            }
                            await this.app.vault.modify(target, result.newContent);
                            if (pendingByPath) this.consumePendingLinkPlaceholder(pendingByPath.key);
                            if (pendingByName) this.consumePendingLinkPlaceholder(pendingByName.key);
                            return resolve(true);
                        }
                    } catch (_) {
                        // Fall through to false.
                    }
                }

                console.warn(`NotePix: Could not find link for "${fileName}" to replace.`);
                resolve(false);
            }, 100);
        });
    }

    // Capture placeholder in current note content matching this file
    captureFilePlaceholder(file) {
        if (!file) return;
        const normalizedPath = this.normalizeVaultPath(file.path);
        if (!normalizedPath) return;
        setTimeout(() => {
            const activeView = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
            if (!activeView) return;
            const editor = activeView.editor;
            if (!editor) return;
            let content = "";
            if (typeof editor.getDoc === 'function') {
                try {
                    const doc = editor.getDoc();
                    content = doc?.getValue?.() || "";
                } catch (_) {
                    content = "";
                }
            }
            if (!content && typeof editor.getValue === 'function') {
                try {
                    content = editor.getValue();
                } catch (_) {
                    content = "";
                }
            }
            if (!content) return;

            const escapedPath = normalizedPath.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
            const regex = new RegExp(`!\\[\\[[^\\]]*${escapedPath}[^\\]]*\\]\\]`);
            const match = content.match(regex);
            const sourcePath = activeView.file?.path || "";
            if (match && match[0]) {
                this.recordPendingLinkPlaceholder(file.path, match[0], sourcePath);
                return;
            }
            // Mobile-oriented fallback by filename
            if (this.recentPlaceholdersByName && this.recentPlaceholdersByName.size > 0) {
                const rec = this.recentPlaceholdersByName.get(file.name);
                if (rec && rec.placeholder) {
                    this.recordPendingLinkPlaceholder(file.path, rec.placeholder, sourcePath);
                    this.recordPendingLinkPlaceholder(file.name, rec.placeholder, sourcePath);
                    this.recentPlaceholdersByName.delete(file.name);
                }
            }
        }, 200);
    }

    async handleDeclinedUpload(file) {
        if (!file) {
            new import_obsidian.Notice("Attachment kept locally.");
            return;
        }
        try {
            const relocation = await this.moveFileToLocalOnly(file);
            if (!relocation) {
                new import_obsidian.Notice(`${file.name} kept locally in attachments.`);
                return;
            }
            const replaced = await this.replaceLinkInEditor(relocation.originalName, relocation.newPath, relocation.originalPath, { replacementType: 'wiki' });
            if (replaced) {
                new import_obsidian.Notice(`${relocation.originalName} moved to local-only folder.`);
            } else {
                new import_obsidian.Notice(`${relocation.originalName} moved to local-only folder. Please update the link manually.`);
            }
        } catch (e) {
            console.error('NotePix: Failed to move declined attachment', e);
            new import_obsidian.Notice(`Could not move ${file.name} to local folder.`);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }
    async saveSettings() {
        await this.saveData(this.settings);
    }
};

// PasswordPrompt from clean baseline
var PasswordPrompt = class extends import_obsidian.Modal {
    constructor(app) {
        super(app);
        this.password = "";
        this.submitted = false;
    }
    open() {
        return new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
            super.open();
        });
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "Enter master password" });
        new import_obsidian.Setting(contentEl).setName("Password").addText((text) => {
            text.inputEl.type = "password";
            text.onChange((value) => {
                this.password = value;
            });
            text.inputEl.addEventListener("keydown", (event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    this.submit();
                }
            });
        });
        new import_obsidian.Setting(contentEl).addButton(
            (btn) => btn.setButtonText("Submit").setCta().onClick(() => this.submit())
        );
    }
    submit() {
        this.submitted = true;
        this.resolve(this.password);
        this.close();
    }
    onClose() {
        if (!this.submitted) {
            this.reject(new Error("Password not provided"));
        }
    }
};

// Simple modal to pick a folder from the vault (baseline)
var SimpleFolderPickerModal = class extends import_obsidian.Modal {
    constructor(app, folderPaths, onPick) {
        super(app);
        this.folderPaths = folderPaths;
        this.onPick = onPick;
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: 'Choose a folder' });
        const list = contentEl.createEl('div', { cls: 'notepix-folder-picker' });
        const makeButton = (label, val) => {
            const btn = list.createEl('button', { text: label, cls: 'mod-cta' });
            btn.style.display = 'block';
            btn.style.marginBottom = '6px';
            btn.onclick = () => {
                this.onPick?.(val);
                this.close();
            };
        };
        // Root folder entry
        makeButton('/', '');
        // Other folders
        (this.folderPaths || [])
            .filter(p => p.length > 0)
            .sort((a, b) => a.localeCompare(b))
            .forEach(p => makeButton(`/${p}`, p));
    }
    onClose() {
        this.contentEl.empty();
    }
};

// Searchable vault folder picker using FuzzySuggestModal (baseline)
var VaultFolderSuggestModal = class extends import_obsidian.FuzzySuggestModal {
    constructor(app, folderPaths, onPick) {
        super(app);
        this.folderPaths = (folderPaths || []).map(p => (p || '').replace(/\\\\/g, "/").replace(/^\/+|\/+$/g, ""));
        this.onPick = onPick;
    }
    getItems() {
        // Include root as empty string to show '/'
        const uniq = new Set(['', ...this.folderPaths]);
        return Array.from(uniq.values());
    }
    getItemText(item) {
        return item === '' ? '/' : `/${item}`;
    }
    onChooseItem(item, evt) {
        this.onPick?.(item);
    }
};

// Settings tab copied from baseline
var GitHubUploaderSettingTab = class extends import_obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.masterPassword = "";
        this.githubToken = "";
        this.plugin = plugin;
        // UI state: reveal extra folders input only when requested or already set
        this.showExtraFolders = (this.plugin.settings.extraWatchedFolders || "").trim().length > 0;
        // Track last valid upload folder for inline validation
        this.lastValidUploadFolder = this.plugin.settings.uploadImageFolder || 'notepix-uploads';
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        new import_obsidian.Setting(containerEl).setName("GitHub username").addText((text) => text.setPlaceholder("your-name").setValue(this.plugin.settings.githubUser).onChange(async (value) => {
            this.plugin.settings.githubUser = value;
            this.plugin.clearRepoPrivacyCache();
            this.plugin.clearRepoListCache();
            await this.plugin.saveSettings();
        }));
        new import_obsidian.Setting(containerEl).setName("Repository name").addText((text) => text.setPlaceholder("obsidian-assets").setValue(this.plugin.settings.repoName).onChange(async (value) => {
            const previousRepo = (this.plugin.settings.repoName || '').trim();
            const nextRepo = (value || '').trim();
            if (previousRepo && nextRepo && previousRepo !== nextRepo) {
                const history = Array.isArray(this.plugin.settings.repoHistory) ? [...this.plugin.settings.repoHistory] : [];
                const filtered = history.filter(r => String(r || '').trim() && String(r || '').trim() !== previousRepo && String(r || '').trim() !== nextRepo);
                this.plugin.settings.repoHistory = [previousRepo, ...filtered].slice(0, 10);
            }
            this.plugin.settings.repoName = value;
            this.plugin.clearRepoPrivacyCache();
            this.plugin.clearRepoListCache();
            await this.plugin.saveSettings();
        }));
        new import_obsidian.Setting(containerEl)
            .setName("Repository visibility")
            .setDesc("Auto: detects repo type and adapts. Public/Private: forces the chosen mode.")
            .addDropdown(dropdown => dropdown
                .addOption('auto', 'Auto (Recommended)')
                .addOption('public', 'Public')
                .addOption('private', 'Private')
                .setValue(this.plugin.settings.repoVisibility || 'auto')
                .onChange(async (value) => {
                    this.plugin.settings.repoVisibility = value;
                    this.plugin.clearRepoPrivacyCache();
                    this.plugin.clearRepoListCache();
                    await this.plugin.saveSettings();
                }));
        new import_obsidian.Setting(containerEl).setName("Branch name").addText((text) => text.setPlaceholder("main").setValue(this.plugin.settings.branchName).onChange(async (value) => {
            this.plugin.settings.branchName = value;
            await this.plugin.saveSettings();
        }));
        new import_obsidian.Setting(containerEl).setName("Folder path in repository").addText((text) => text.setPlaceholder("assets/").setValue(this.plugin.settings.folderPath).onChange(async (value) => {
            this.plugin.settings.folderPath = value.length > 0 && !value.endsWith("/") ? value + "/" : value;
            await this.plugin.saveSettings();
        }));
        new import_obsidian.Setting(containerEl).setName("Delete local file after upload").addToggle((toggle) => toggle.setValue(this.plugin.settings.deleteLocal).onChange(async (value) => {
            this.plugin.settings.deleteLocal = value;
            await this.plugin.saveSettings();
        }));

        new import_obsidian.Setting(containerEl)
            .setName("Use jsDelivr CDN for public images")
            .setDesc("Optional. When ON and the repository is public, new uploads use fast cached CDN links (cdn.jsdelivr.net) instead of raw GitHub links. Automatically ignored for private repos — jsDelivr cannot serve private repositories. Use the 'Convert image links' commands to migrate existing notes.")
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.useCdn).onChange(async (value) => {
                this.plugin.settings.useCdn = value;
                await this.plugin.saveSettings();
            }));

        new import_obsidian.Setting(containerEl)
            .setName("Image storage layout in repository")
            .setDesc("Optional. 'Global folder' stores all images in the folder path above. 'Mirror note path' stores each note's images in a repo folder matching the note's location (folder/note name), under the base folder below. Only affects NEW uploads.")
            .addDropdown(dropdown => dropdown
                .addOption('global', 'Global folder (default)')
                .addOption('byNotePath', 'Mirror note path')
                .setValue(this.plugin.settings.imageStorageStrategy || 'global')
                .onChange(async (value) => {
                    this.plugin.settings.imageStorageStrategy = value;
                    await this.plugin.saveSettings();
                    this.display(); // re-render to show/hide the base-folder field
                }));

        if ((this.plugin.settings.imageStorageStrategy || 'global') === 'byNotePath') {
            new import_obsidian.Setting(containerEl)
                .setName("Base folder for note-path layout")
                .setDesc("Repository folder under which the mirrored note paths are created (e.g. 'assets' → assets/Projects/My-Note/...). Note/folder names are sanitized to safe characters.")
                .addText((text) => text
                    .setPlaceholder("assets")
                    .setValue(this.plugin.settings.byNotePathBaseFolder || 'assets')
                    .onChange(async (value) => {
                        this.plugin.settings.byNotePathBaseFolder = value;
                        await this.plugin.saveSettings();
                    }));
        }

        new import_obsidian.Setting(containerEl)
            .setName("Name images after the note / heading")
            .setDesc("Optional. When ON, a pasted image is named after the note (e.g. 'MyNote-1.png'), or 'Note-Heading-1.png' when pasted under a heading, instead of a timestamp. Readable and stable across reorders.")
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.headingBasedNaming).onChange(async (value) => {
                this.plugin.settings.headingBasedNaming = value;
                await this.plugin.saveSettings();
            }));

        new import_obsidian.Setting(containerEl)
            .setName("Pasted image upload behavior")
            .setDesc("Choose whether to upload pasted images automatically or to be asked each time.")
            .addDropdown(dropdown => dropdown
                .addOption('always', 'Always Upload')
                .addOption('ask', 'Ask Before Uploading')
                .setValue(this.plugin.settings.uploadOnPaste || 'always')
                .onChange(async (value) => {
                    this.plugin.settings.uploadOnPaste = value;
                    await this.plugin.saveSettings();
                }));

        const localPrimarySetting = new import_obsidian.Setting(containerEl)
            .setName("Local image folder")
            .setDesc("The primary folder where images will be saved when you choose not to upload them.")
            .addText(text => text
                .setPlaceholder("notepix-local")
                .setValue(this.plugin.settings.localImageFolder)
                .onChange(async (value) => {
                    this.plugin.settings.localImageFolder = value;
                    await this.plugin.saveSettings();
                }));
        localPrimarySetting.addExtraButton((btn) => {
            btn.setIcon?.("folder-open");
            if (!btn.setIcon) btn.setButtonText("Browse");
            btn.setTooltip?.("Choose folder from vault");
            btn.onClick(() => {
                const folders = this.plugin.getVaultFolderPaths();
                const modal = new VaultFolderSuggestModal(this.app, folders, async (picked) => {
                    this.plugin.settings.localImageFolder = picked || '';
                    await this.plugin.saveSettings();
                    this.display();
                });
                modal.open();
            });
        });
        // Plus button to reveal local-only rows, matching the Upload section UX
        localPrimarySetting.addExtraButton((btn) => {
            btn.setIcon?.("plus");
            if (!btn.setIcon) btn.setButtonText("+");
            btn.setTooltip?.("Add more local-only folders");
            btn.onClick(() => {
                const section = containerEl.querySelector('.notepix-localonly-folders');
                if (!section) renderLocalOnlyRows();
            });
        });

        // Anchor where local-only section will render on demand (hidden until plus is clicked)
        const localOnlyAnchor = containerEl.createDiv({ cls: 'notepix-localonly-anchor' });

        const renderLocalOnlyRows = () => {
            const existing = localOnlyAnchor.querySelector('.notepix-localonly-folders');
            if (existing) existing.remove();
            const section = localOnlyAnchor.createDiv({ cls: 'notepix-localonly-folders' });
            section.createEl('h4', { text: 'Additional local-only folders' });

            // Seed model from structured or CSV fallback
            const fromCSV = (v) => (v || '').split(',').map(s => s.trim()).filter(Boolean).map(p => ({ path: p, label: '' }));
            let locals = Array.isArray(this.plugin.settings.localOnlyList) && this.plugin.settings.localOnlyList.length > 0
                ? this.plugin.settings.localOnlyList.map(e => ({ path: e.path || '', label: e.label || '' }))
                : fromCSV(this.plugin.settings.localOnlyFolders);

            const allFolders = this.plugin.getVaultFolderPaths();
            const isValidPath = (p) => allFolders.includes(p) || p === '';

            const save = async () => {
                // Enforce mutual exclusivity for non-empty paths only; keep empty rows so +Add works
                const uploadNorm = (this.plugin.settings.uploadImageFolder || 'notepix-uploads').replace(/\\\\/g, "/").replace(/^\/+|\/+$/g, "");
                const extra = (Array.isArray(this.plugin.settings.extraWatchedList) && this.plugin.settings.extraWatchedList.length > 0
                    ? this.plugin.settings.extraWatchedList.map(e => e?.path || '')
                    : (this.plugin.settings.extraWatchedFolders || '').split(','))
                    .map(s => (s || '').trim()).filter(Boolean)
                    .map(s => s.replace(/\\\\/g, "/").replace(/^\/+|\/+$/g, ""));
                locals = locals.filter(f => {
                    const raw = f.path || '';
                    if (!raw.trim()) return true; // keep empty rows
                    const p = raw.replace(/\\\\/g, "/").replace(/^\/+|\/+$/g, "");
                    return p !== uploadNorm && !extra.includes(p);
                });
                // Persist structured and CSV fallbacks
                this.plugin.settings.localOnlyList = locals;
                this.plugin.settings.localOnlyFolders = locals.map(f => f.path).filter(Boolean).join(', ');
                await this.plugin.saveSettings();
            };

            locals.forEach((item, idx) => {
                const row = new import_obsidian.Setting(section).setName(`Local-only ${idx + 1}`);
                // Path input with validation
                row.addText(t => {
                    t.setPlaceholder('path/to/folder')
                        .setValue(item.path)
                        .onChange(async (val) => {
                            item.path = val.trim();
                            await save();
                            const valid = isValidPath(item.path);
                            t.inputEl.style.borderColor = valid || item.path.length === 0 ? '' : 'var(--color-red)';
                        });
                });
                // Browse
                row.addExtraButton(btn => {
                    btn.setIcon?.('folder-open');
                    if (!btn.setIcon) btn.setButtonText('Browse');
                    btn.setTooltip?.('Choose folder from vault');
                    btn.onClick(() => {
                        const modal = new VaultFolderSuggestModal(this.app, allFolders, async (picked) => {
                            item.path = picked || '';
                            await save();
                            renderLocalOnlyRows();
                        });
                        modal.open();
                    });
                });
                // Label
                row.addText(t => {
                    t.setPlaceholder('Optional label (e.g., Local screenshots)')
                        .setValue(item.label || '')
                        .onChange(async (val) => {
                            item.label = val;
                            await save();
                        });
                });
                // Reorder up/down
                row.addExtraButton(btn => {
                    btn.setIcon?.('arrow-up');
                    if (!btn.setIcon) btn.setButtonText('Up');
                    btn.setTooltip?.('Move up');
                    btn.onClick(async () => {
                        if (idx > 0) {
                            const tmp = locals[idx - 1];
                            locals[idx - 1] = locals[idx];
                            locals[idx] = tmp;
                            await save();
                            renderLocalOnlyRows();
                        }
                    });
                });
                row.addExtraButton(btn => {
                    btn.setIcon?.('arrow-down');
                    if (!btn.setIcon) btn.setButtonText('Down');
                    btn.setTooltip?.('Move down');
                    btn.onClick(async () => {
                        if (idx < locals.length - 1) {
                            const tmp = locals[idx + 1];
                            locals[idx + 1] = locals[idx];
                            locals[idx] = tmp;
                            await save();
                            renderLocalOnlyRows();
                        }
                    });
                });
                // Remove
                row.addExtraButton(btn => {
                    btn.setIcon?.('trash');
                    if (!btn.setIcon) btn.setButtonText('Remove');
                    btn.setTooltip?.('Remove this folder');
                    btn.onClick(async () => {
                        locals.splice(idx, 1);
                        await save();
                        renderLocalOnlyRows();
                    });
                });
            });

            // Add row button
            const addRow = new import_obsidian.Setting(section).setName('Add local-only folder');
            addRow.addButton(b => b.setButtonText('+ Add').setCta().onClick(async () => {
                locals.push({ path: '', label: '' });
                await save();
                renderLocalOnlyRows();
            }));
        };

        // Auto-render local-only rows if settings already contain values
        if ((this.plugin.settings.localOnlyFolders || '').trim().length > 0 || (this.plugin.settings.localOnlyList || []).length > 0) {
            renderLocalOnlyRows();
        }

        const uploadSetting = new import_obsidian.Setting(containerEl)
            .setName("Upload image folder")
            .setDesc("Default folder where NotePix saves images that will be uploaded.");
        uploadSetting.addText(text => {
            text
                .setPlaceholder("notepix-uploads")
                .setValue(this.plugin.settings.uploadImageFolder || 'notepix-uploads')
                .onChange(async (value) => {
                    const val = (value || '').replace(/\\\\/g, "/").replace(/^\/+|\/+$/g, "").trim();
                    // Build local-only list (structured or CSV or legacy)
                    const localOnly = (Array.isArray(this.plugin.settings.localOnlyList) && this.plugin.settings.localOnlyList.length > 0
                        ? this.plugin.settings.localOnlyList.map(e => e?.path || '')
                        : (this.plugin.settings.localOnlyFolders || this.plugin.settings.localImageFolder || 'notepix-local').split(','))
                        .map(s => (s || '').trim())
                        .filter(Boolean)
                        .map(s => s.replace(/\\\\/g, "/").replace(/^\/+|\/+$/g, ""));

                    const conflicts = val.length > 0 && localOnly.includes(val);
                    if (conflicts) {
                        // Visual warning and revert to last valid value
                        text.inputEl.style.borderColor = 'var(--color-red)';
                        new import_obsidian.Notice("Upload folder cannot be one of the local-only folders.");
                        setTimeout(() => {
                            text.setValue(this.lastValidUploadFolder || 'notepix-uploads');
                            text.inputEl.style.borderColor = '';
                        }, 0);
                        return;
                    }

                    text.inputEl.style.borderColor = '';
                    this.plugin.settings.uploadImageFolder = val;
                    this.lastValidUploadFolder = val;
                    await this.plugin.saveSettings();
                });
        });
        uploadSetting.addExtraButton((btn) => {
            btn.setIcon?.("folder-open");
            if (!btn.setIcon) btn.setButtonText("Browse");
            btn.setTooltip?.("Choose folder from vault");
            btn.onClick(() => {
                const folders = this.plugin.getVaultFolderPaths();
                const modal = new VaultFolderSuggestModal(this.app, folders, (picked) => {
                    const val = (picked || '').replace(/\\\\/g, "/").replace(/^\/+|\/+$/g, "");
                    // Conflict check against local-only
                    const localOnly = (Array.isArray(this.plugin.settings.localOnlyList) && this.plugin.settings.localOnlyList.length > 0
                        ? this.plugin.settings.localOnlyList.map(e => e?.path || '')
                        : (this.plugin.settings.localOnlyFolders || this.plugin.settings.localImageFolder || 'notepix-local').split(','))
                        .map(s => (s || '').trim())
                        .filter(Boolean)
                        .map(s => s.replace(/\\\\/g, "/").replace(/^\/+|\/+$/g, ""));
                    if (val && localOnly.includes(val)) {
                        new import_obsidian.Notice("Upload folder cannot be one of the local-only folders.");
                        return;
                    }
                    this.plugin.settings.uploadImageFolder = val;
                    this.lastValidUploadFolder = val;
                    this.plugin.saveSettings();
                    this.display();
                });
                modal.open();
            });
        });

        // MOBILE INFO: show that attachments folder is auto-watched on mobile
        if (isMobile) {
            new import_obsidian.Setting(containerEl)
                .setName("Mobile attachments integration")
                .setDesc("On mobile, files added via the attachment button are saved to and uploaded from the 'attachment' folder.")
                .addText(t => {
                    t.setValue(this.plugin.settings.attachmentsFolderName || 'attachment');
                    t.setDisabled(true);
                });
        }

        // Create anchor right below the upload section so extra folders render under the plus button
        const extraAnchor = containerEl.createDiv({ cls: 'notepix-extra-anchor' });
        uploadSetting.addExtraButton((btn) => {
            btn.setIcon?.("plus");
            btn.setTooltip?.("Add more folders to watch");
            // Fallback text if setIcon is not available
            if (!btn.setIcon) btn.setButtonText("+");
            btn.onClick(() => {
                this.showExtraFolders = true;
                this.display();
            });
        });

        if (this.showExtraFolders || (this.plugin.settings.extraWatchedFolders || "").trim().length > 0 || (this.plugin.settings.extraWatchedList || []).length > 0) {
            extraAnchor.createEl('h4', { text: 'Additional watched folders' });

            // Seed folders model from structured list or CSV fallback
            const fromCSV = (v) => (v || '').split(',').map(s => s.trim()).filter(Boolean).map(p => ({ path: p, label: '' }));
            let folders = Array.isArray(this.plugin.settings.extraWatchedList) && this.plugin.settings.extraWatchedList.length > 0
                ? this.plugin.settings.extraWatchedList.map(e => ({ path: e.path || '', label: e.label || '' }))
                : fromCSV(this.plugin.settings.extraWatchedFolders);

            const allFolders = this.plugin.getVaultFolderPaths();
            const isValidPath = (p) => allFolders.includes(p) || p === '';

            const save = async () => {
                // Filter out exact duplicates (keep first occurrences) and persist
                const seen = new Set();
                const deduped = [];
                for (const f of folders) {
                    const p = (f.path || '').replace(/\\\\/g, "/").replace(/^\/+|\/+$/g, "");
                    if (!p) continue; // keep empty rows out of persisted list
                    if (seen.has(p)) continue;
                    seen.add(p);
                    deduped.push({ path: p, label: f.label || '' });
                }
                this.plugin.settings.extraWatchedList = deduped;
                this.plugin.settings.extraWatchedFolders = deduped.map(f => f.path).join(', ');
                await this.plugin.saveSettings();
            };

            const renderRows = () => {
                const existing = extraAnchor.querySelector('.notepix-extra-folders');
                if (existing) existing.remove();
                const section = extraAnchor.createDiv({ cls: 'notepix-extra-folders' });

                folders.forEach((item, idx) => {
                    const row = new import_obsidian.Setting(section).setName(`Folder ${idx + 1}`);

                    // Path input with validation
                    row.addText(t => {
                        t.setPlaceholder('path/to/folder')
                            .setValue(item.path)
                            .onChange(async (val) => {
                                item.path = val.trim();
                                // Build conflict sets
                                const uploadNorm = (this.plugin.settings.uploadImageFolder || 'notepix-uploads').replace(/\\\\/g, "/").replace(/^\/+|\/+$/g, "");
                                const localOnly = (Array.isArray(this.plugin.settings.localOnlyList) && this.plugin.settings.localOnlyList.length > 0
                                    ? this.plugin.settings.localOnlyList.map(e => e?.path || '')
                                    : (this.plugin.settings.localOnlyFolders || this.plugin.settings.localImageFolder || 'notepix-local').split(','))
                                    .map(s => (s || '').trim())
                                    .filter(Boolean)
                                    .map(s => s.replace(/\\\\/g, "/").replace(/^\/+|\/+$/g, ""));
                                const valNorm = (item.path || '').replace(/\\\\/g, "/").replace(/^\/+|\/+$/g, "");
                                const duplicate = folders.some((f, j) => j !== idx && (f.path || '').replace(/\\\\/g, "/").replace(/^\/+|\/+$/g, "") === valNorm);
                                const conflicts = valNorm && (valNorm === uploadNorm || localOnly.includes(valNorm) || duplicate);
                                await save();
                                // visual validation: red if invalid path or conflicts
                                const valid = isValidPath(item.path) && !conflicts;
                                t.inputEl.style.borderColor = valid || item.path.length === 0 ? '' : 'var(--color-red)';
                                if (!valid && item.path.length > 0) {
                                    new import_obsidian.Notice(duplicate ? 'This folder is already listed.' : 'Folder conflicts with upload or local-only folders.');
                                }
                            });
                    });

                    // Browse button
                    row.addExtraButton(btn => {
                        btn.setIcon?.('folder-open');
                        if (!btn.setIcon) btn.setButtonText('Browse');
                        btn.setTooltip?.('Choose folder from vault');
                        btn.onClick(() => {
                            const modal = new VaultFolderSuggestModal(this.app, allFolders, async (picked) => {
                                const uploadNorm = (this.plugin.settings.uploadImageFolder || 'notepix-uploads').replace(/\\\\/g, "/").replace(/^\/+|\/+$/g, "");
                                const localOnly = (Array.isArray(this.plugin.settings.localOnlyList) && this.plugin.settings.localOnlyList.length > 0
                                    ? this.plugin.settings.localOnlyList.map(e => e?.path || '')
                                    : (this.plugin.settings.localOnlyFolders || this.plugin.settings.localImageFolder || 'notepix-local').split(','))
                                    .map(s => (s || '').trim())
                                    .filter(Boolean)
                                    .map(s => s.replace(/\\\\/g, "/").replace(/^\/+|\/+$/g, ""));
                                const pickedNorm = (picked || '').replace(/\\\\/g, "/").replace(/^\/+|\/+$/g, "");
                                const duplicate = folders.some((f, j) => j !== idx && (f.path || '').replace(/\\\\/g, "/").replace(/^\/+|\/+$/g, "") === pickedNorm);
                                if (pickedNorm && (pickedNorm === uploadNorm || localOnly.includes(pickedNorm))) {
                                    new import_obsidian.Notice('Cannot watch this folder: conflicts with upload/local-only.');
                                    return;
                                }
                                if (duplicate) {
                                    new import_obsidian.Notice('This folder is already listed.');
                                    return;
                                }
                                item.path = pickedNorm;
                                await save();
                                renderRows();
                            });
                            modal.open();
                        });
                    });

                    // Label input
                    row.addText(t => {
                        t.setPlaceholder('Optional label (e.g., Screenshots)')
                            .setValue(item.label || '')
                            .onChange(async (val) => {
                                item.label = val;
                                await save();
                            });
                    });

                    // Reorder up/down
                    row.addExtraButton(btn => {
                        btn.setIcon?.('arrow-up');
                        if (!btn.setIcon) btn.setButtonText('Up');
                        btn.setTooltip?.('Move up');
                        btn.onClick(async () => {
                            if (idx > 0) {
                                const tmp = folders[idx - 1];
                                folders[idx - 1] = folders[idx];
                                folders[idx] = tmp;
                                await save();
                                renderRows();
                            }
                        });
                    });
                    row.addExtraButton(btn => {
                        btn.setIcon?.('arrow-down');
                        if (!btn.setIcon) btn.setButtonText('Down');
                        btn.setTooltip?.('Move down');
                        btn.onClick(async () => {
                            if (idx < folders.length - 1) {
                                const tmp = folders[idx + 1];
                                folders[idx + 1] = folders[idx];
                                folders[idx] = tmp;
                                await save();
                                renderRows();
                            }
                        });
                    });

                    // Remove row
                    row.addExtraButton(btn => {
                        btn.setIcon?.('trash');
                        if (!btn.setIcon) btn.setButtonText('Remove');
                        btn.setTooltip?.('Remove this folder');
                        btn.onClick(async () => {
                            folders.splice(idx, 1);
                            await save();
                            renderRows();
                        });
                    });
                });

                // Add row button
                const addRow = new import_obsidian.Setting(section).setName('Add folder');
                addRow.addButton(b => b.setButtonText('+ Add').setCta().onClick(async () => {
                    folders.push({ path: '', label: '' });
                    await save();
                    renderRows();
                }));
            };

            renderRows();
        }

        new import_obsidian.Setting(containerEl).setName("Encryption").setHeading();
        new import_obsidian.Setting(containerEl)
            .setName("Enable encryption")
            .setDesc("When enabled, your PAT is encrypted and you'll be prompted once per session when it's first needed.")
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.useEncryption)
                .onChange(async (value) => {
                    if (this.plugin.settings.useEncryption && !value) {
                        const ok = await new ConfirmationModal(this.app, "Disable encryption?", "Your PAT will be stored in plain text locally. Are you sure?").open();
                        if (!ok) {
                            // Revert UI state
                            this.plugin.settings.useEncryption = true;
                            await this.plugin.saveSettings();
                            this.display();
                            return;
                        }
                    }
                    this.plugin.settings.useEncryption = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        if (this.plugin.settings.useEncryption) {
            // Encrypted mode UI: master password field + token field + save encrypted token button
            new import_obsidian.Setting(containerEl).setName("Master password").setDesc("Set a password to encrypt your token. This is NOT saved.").addText((text) => {
                text.inputEl.type = "password";
                text.setPlaceholder("Enter password to set/change token");
                text.onChange((value) => {
                    this.masterPassword = value;
                });
            });
            new import_obsidian.Setting(containerEl).setName("GitHub personal access token").setDesc("Enter your PAT here. It will be encrypted on save.").addText((text) => {
                text.inputEl.type = "password";
                text.setPlaceholder("ghp_... (paste new token here)");
                text.onChange((value) => {
                    this.githubToken = value;
                });
            });
            new import_obsidian.Setting(containerEl).addButton((button) => button.setButtonText("Save encrypted token").setCta().onClick(async () => {
                if (!this.masterPassword || !this.githubToken) {
                    new import_obsidian.Notice("Please provide both a Master Password and a Token.");
                    return;
                }
                try {
                    const encrypted = await encrypt(this.githubToken, this.masterPassword);
                    this.plugin.settings.encryptedToken = encrypted;
                    // Clear plain token for security when switching to encrypted mode
                    this.plugin.settings.plainToken = "";
                    this.plugin.clearRepoPrivacyCache();
                    this.plugin.clearRepoListCache();
                    await this.plugin.saveSettings();
                    new import_obsidian.Notice("Token has been encrypted and saved!");
                } catch (e) {
                    new import_obsidian.Notice(`Encryption failed: ${e.message}`);
                }
            }));
        } else {
            // Plain mode UI: simple plain PAT field, no password prompts
            new import_obsidian.Setting(containerEl)
                .setName("GitHub personal access token (plain)")
                .setDesc("Stored in plain text. No password prompts in this mode.")
                .addText((text) => {
                    text.inputEl.type = "password";
                    text.setPlaceholder("ghp_... (paste token)");
                    text.setValue(this.plugin.settings.plainToken || "");
                    text.onChange(async (value) => {
                        this.plugin.settings.plainToken = value;
                        this.plugin.clearRepoPrivacyCache();
                        this.plugin.clearRepoListCache();
                        await this.plugin.saveSettings();
                    });
                });
        }
    }
};

var ConfirmationModal = class extends import_obsidian.Modal {
    constructor(app, title, message) {
        super(app);
        this.title = title;
        this.message = message;
        this.confirmed = false;
    }

    open() {
        return new Promise((resolve) => {
            this.resolve = resolve;
            super.open();
        });
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: this.title });
        contentEl.createEl("p", { text: this.message });

        new import_obsidian.Setting(contentEl)
            .addButton(btn => btn
                .setButtonText("Yes")
                .setCta()
                .onClick(() => {
                    this.confirmed = true;
                    this.close();
                }))
            .addButton(btn => btn
                .setButtonText("No")
                .onClick(() => {
                    this.confirmed = false;
                    this.close();
                }));
    }

    onClose() {
        this.resolve(this.confirmed);
    }
}

var RepoMismatchModal = class extends import_obsidian.Modal {
    constructor(app, repoKey) {
        super(app);
        this.repoKey = repoKey;
        this.choice = null;
    }

    openAndWait() {
        return new Promise((resolve) => {
            this.resolve = resolve;
            super.open();
        });
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "Repository Privacy Mismatch Detected" });
        contentEl.createEl("p", {
            text: `Your repository "${this.repoKey}" appears to be private, but some images in this note use public raw URLs that may not load correctly.`
        });
        contentEl.createEl("p", { text: "How would you like NotePix to handle image URLs going forward?" });

        const buttonContainer = contentEl.createDiv({ cls: 'notepix-mismatch-buttons' });
        buttonContainer.style.display = 'flex';
        buttonContainer.style.flexDirection = 'column';
        buttonContainer.style.gap = '8px';
        buttonContainer.style.marginTop = '12px';

        const makeBtn = (text, desc, choice, cta) => {
            const wrapper = buttonContainer.createDiv();
            const btn = wrapper.createEl('button', { text, cls: cta ? 'mod-cta' : '' });
            btn.style.width = '100%';
            btn.style.textAlign = 'left';
            btn.style.padding = '8px 12px';
            if (desc) {
                const descEl = wrapper.createEl('small', { text: desc });
                descEl.style.display = 'block';
                descEl.style.opacity = '0.7';
                descEl.style.marginTop = '2px';
                descEl.style.marginLeft = '12px';
            }
            btn.onclick = () => {
                this.choice = choice;
                this.close();
            };
        };

        makeBtn("Use Auto Mode", "Detects repo type and adapts automatically. Recommended.", "auto", true);
        makeBtn("Switch to Private", "All future uploads will use the private image format.", "private", false);
        makeBtn("Keep Public", "No change. Raw URLs may not load for private repos.", "public", false);
    }

    onClose() {
        if (this.resolve) this.resolve(this.choice);
    }
}

// --- Issue #7: delete confirmation modal (image used nowhere else) ---
// Resolves to true (delete) or false (cancel). States irreversibility plainly.
var DeleteImageModal = class extends import_obsidian.Modal {
    constructor(app, refLabel) {
        super(app);
        this.refLabel = refLabel;
        this.confirmed = false;
    }
    openAndWait() {
        return new Promise((resolve) => { this.resolve = resolve; super.open(); });
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "Delete image from GitHub?" });
        contentEl.createEl("p", { text: `This will permanently delete the file from GitHub and remove its link from this note:` });
        const code = contentEl.createEl("p", { text: this.refLabel });
        code.style.fontFamily = 'var(--font-monospace)';
        code.style.wordBreak = 'break-all';
        code.style.opacity = '0.8';
        const warn = contentEl.createEl("p", { text: "⚠️ This cannot be undone." });
        warn.style.color = 'var(--text-error)';
        new import_obsidian.Setting(contentEl)
            .addButton(btn => btn.setButtonText("Cancel").onClick(() => { this.confirmed = false; this.close(); }))
            .addButton(btn => btn.setButtonText("Delete").setWarning().onClick(() => { this.confirmed = true; this.close(); }));
    }
    onClose() { if (this.resolve) this.resolve(this.confirmed); }
};

// --- Issue #7: multi-note delete modal (image used in OTHER notes/canvases) ---
// Shows every other location, then offers three explicit choices. Resolves to:
//   'cancel' | 'thisOnly' | 'all'
//   - thisOnly: unlink here, KEEP the GitHub file + other references
//   - all: delete from GitHub + remove from this note AND all other locations
var MultiNoteDeleteModal = class extends import_obsidian.Modal {
    constructor(app, refLabel, otherLocations) {
        super(app);
        this.refLabel = refLabel;
        this.otherLocations = otherLocations || [];
        this.choice = 'cancel';
    }
    openAndWait() {
        return new Promise((resolve) => { this.resolve = resolve; super.open(); });
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "Image is used in other places" });
        const code = contentEl.createEl("p", { text: this.refLabel });
        code.style.fontFamily = 'var(--font-monospace)';
        code.style.wordBreak = 'break-all';
        code.style.opacity = '0.8';
        contentEl.createEl("p", { text: `This image is also referenced in ${this.otherLocations.length} other place(s):` });
        const list = contentEl.createEl("ul");
        list.style.maxHeight = '160px';
        list.style.overflowY = 'auto';
        for (const loc of this.otherLocations) {
            const label = loc.count > 1 ? `${loc.path} (${loc.count}×)` : loc.path;
            list.createEl("li", { text: `${loc.kind === 'canvas' ? '🗺️ ' : '📄 '}${label}` });
        }

        const buttons = contentEl.createDiv();
        buttons.style.display = 'flex';
        buttons.style.flexDirection = 'column';
        buttons.style.gap = '8px';
        buttons.style.marginTop = '12px';
        const makeBtn = (text, desc, choice, warning) => {
            const wrap = buttons.createDiv();
            const btn = wrap.createEl('button', { text });
            btn.style.width = '100%';
            btn.style.textAlign = 'left';
            btn.style.padding = '8px 12px';
            if (warning) btn.addClass('mod-warning');
            const d = wrap.createEl('small', { text: desc });
            d.style.display = 'block';
            d.style.opacity = '0.7';
            d.style.marginLeft = '12px';
            btn.onclick = () => { this.choice = choice; this.close(); };
        };
        makeBtn("Remove only this link", "Unlink it here. Keeps the GitHub file and the other references intact.", "thisOnly", false);
        makeBtn("Remove from everywhere + GitHub", "Deletes the GitHub file and removes the link from this note and all other locations. Cannot be undone.", "all", true);
        makeBtn("Cancel", "Do nothing.", "cancel", false);
    }
    onClose() { if (this.resolve) this.resolve(this.choice); }
};

// --- Issue #7: orphan review modal (report-only; user ticks what to delete) ---
// Never auto-deletes (BP-11). Each orphan has a checkbox (default UNchecked).
// Deletion runs sequentially through the plugin's GitHub delete engine.
var OrphanReviewModal = class extends import_obsidian.Modal {
    constructor(app, plugin, orphans, truncated) {
        super(app);
        this.plugin = plugin;
        this.orphans = orphans || [];
        this.truncated = !!truncated;
        this.checked = new Set();
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "Orphaned images on GitHub" });
        contentEl.createEl("p", { text: `${this.orphans.length} image(s) are not referenced by any note or canvas. Select the ones to permanently delete from GitHub.` });
        if (this.truncated) {
            const t = contentEl.createEl("p", { text: "⚠️ The repository file list was very large and may be incomplete." });
            t.style.color = 'var(--text-warning)';
        }
        const warn = contentEl.createEl("p", { text: "⚠️ Deletion cannot be undone." });
        warn.style.color = 'var(--text-error)';

        const listEl = contentEl.createDiv();
        listEl.style.maxHeight = '300px';
        listEl.style.overflowY = 'auto';
        listEl.style.margin = '8px 0';
        for (const orphan of this.orphans) {
            const row = listEl.createDiv();
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.gap = '8px';
            row.style.padding = '2px 0';
            const cb = row.createEl('input');
            cb.type = 'checkbox';
            cb.onchange = () => { if (cb.checked) this.checked.add(orphan); else this.checked.delete(orphan); };
            const label = row.createEl('span', { text: orphan.path });
            label.style.fontFamily = 'var(--font-monospace)';
            label.style.fontSize = '0.85em';
            label.style.wordBreak = 'break-all';
        }

        new import_obsidian.Setting(contentEl)
            .addButton(btn => btn.setButtonText("Cancel").onClick(() => this.close()))
            .addButton(btn => btn.setButtonText("Delete selected").setWarning().onClick(async () => {
                const toDelete = Array.from(this.checked);
                if (toDelete.length === 0) { new import_obsidian.Notice("Nothing selected."); return; }
                this.close();
                await this.plugin.deleteOrphansSequentially(toDelete);
            }));
    }
    onClose() { this.contentEl.empty(); }
};

// --- Issue #7: multi-select delete modal (checklist of a note's images) ---
// Lists distinct managed images with checkboxes (default UNchecked). On confirm,
// if any selected image is used in OTHER notes, asks once how to handle shared
// ones (skip vs delete-everywhere), then runs the bulk delete.
var MultiDeleteModal = class extends import_obsidian.Modal {
    constructor(app, plugin, file, items) {
        super(app);
        this.plugin = plugin;
        this.file = file;
        this.items = items || [];
        this.checked = new Set();
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "Delete images in this note" });
        contentEl.createEl("p", { text: `${this.items.length} image(s) in this note. Select the ones to delete from GitHub and remove from the note.` });
        const warn = contentEl.createEl("p", { text: "⚠️ Deletion cannot be undone." });
        warn.style.color = 'var(--text-error)';

        const listEl = contentEl.createDiv();
        listEl.style.maxHeight = '300px';
        listEl.style.overflowY = 'auto';
        listEl.style.margin = '8px 0';
        const checkboxes = [];
        for (const item of this.items) {
            const row = listEl.createDiv();
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.gap = '8px';
            row.style.padding = '3px 0';
            const cb = row.createEl('input');
            cb.type = 'checkbox';
            cb.onchange = () => { if (cb.checked) this.checked.add(item); else this.checked.delete(item); };
            checkboxes.push({ cb, item });
            const label = row.createEl('span', { text: item.count > 1 ? `${item.displayName} (${item.count}× in note)` : item.displayName });
            label.style.fontSize = '0.9em';
            label.style.wordBreak = 'break-all';
        }

        // Select-all / none toggle.
        const selAll = new import_obsidian.Setting(contentEl).setName("Select all");
        selAll.addToggle(t => t.setValue(false).onChange(v => {
            this.checked = new Set();
            for (const { cb, item } of checkboxes) { cb.checked = v; if (v) this.checked.add(item); }
        }));

        new import_obsidian.Setting(contentEl)
            .addButton(btn => btn.setButtonText("Cancel").onClick(() => this.close()))
            .addButton(btn => btn.setButtonText("Delete selected").setWarning().onClick(async () => {
                const selected = Array.from(this.checked);
                if (selected.length === 0) { new import_obsidian.Notice("Nothing selected."); return; }
                this.close();
                await this._runDelete(selected);
            }));
    }
    async _runDelete(selected) {
        const token = await this.plugin.getToken();
        if (!token) return;
        // Multi-note guard, decided ONCE for the whole batch.
        const shared = [];
        for (const item of selected) {
            const others = await this.plugin.findImageReferencesInVault(item.ref, { excludePath: this.file.path });
            if (others.length > 0) shared.push({ item, others });
        }
        let sharedChoice = 'deleteEverywhere';
        if (shared.length > 0) {
            sharedChoice = await new BulkSharedChoiceModal(this.app, shared).openAndWait();
            if (sharedChoice === 'cancel') return;
        }
        await this.plugin.bulkDeleteImages(this.file, selected, token, sharedChoice);
    }
    onClose() { this.contentEl.empty(); }
};

// Asked once when a bulk delete includes images used in other notes/canvases.
// Resolves to 'skipShared' | 'deleteEverywhere' | 'cancel'.
var BulkSharedChoiceModal = class extends import_obsidian.Modal {
    constructor(app, shared) {
        super(app);
        this.shared = shared || [];
        this.choice = 'cancel';
    }
    openAndWait() {
        return new Promise((resolve) => { this.resolve = resolve; super.open(); });
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "Some images are used elsewhere" });
        contentEl.createEl("p", { text: `${this.shared.length} of the selected image(s) are also referenced in other notes or canvases:` });
        const list = contentEl.createEl("ul");
        list.style.maxHeight = '150px';
        list.style.overflowY = 'auto';
        for (const s of this.shared) {
            const where = s.others.map(o => o.path).join(', ');
            list.createEl("li", { text: `${s.item.displayName} — also in: ${where}` });
        }
        const buttons = contentEl.createDiv();
        buttons.style.display = 'flex';
        buttons.style.flexDirection = 'column';
        buttons.style.gap = '8px';
        buttons.style.marginTop = '12px';
        const makeBtn = (text, desc, choice, warning) => {
            const wrap = buttons.createDiv();
            const btn = wrap.createEl('button', { text });
            btn.style.width = '100%'; btn.style.textAlign = 'left'; btn.style.padding = '8px 12px';
            if (warning) btn.addClass('mod-warning');
            const d = wrap.createEl('small', { text: desc });
            d.style.display = 'block'; d.style.opacity = '0.7'; d.style.marginLeft = '12px';
            btn.onclick = () => { this.choice = choice; this.close(); };
        };
        makeBtn("Skip shared images", "Delete only the images used nowhere else. Keeps the shared ones (and other notes) intact.", "skipShared", false);
        makeBtn("Delete everywhere + GitHub", "Delete the GitHub files and remove these links from ALL notes/canvases. Cannot be undone.", "deleteEverywhere", true);
        makeBtn("Cancel", "Do nothing.", "cancel", false);
    }
    onClose() { if (this.resolve) this.resolve(this.choice); }
};

module.exports = MyPlugin;

