var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => MyPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");

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
function bufferToBase64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}
function base64ToBuffer(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
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
  return `${bufferToBase64(salt)}:${bufferToBase64(iv)}:${bufferToBase64(encryptedContent)}`;
}
async function decrypt(encryptedString, password) {
  const [saltB64, ivB64, encryptedB64] = encryptedString.split(":");
  if (!saltB64 || !ivB64 || !encryptedB64) {
    throw new Error("Invalid encrypted data format.");
  }
  const salt = base64ToBuffer(saltB64);
  const iv = base64ToBuffer(ivB64);
  const encryptedContent = base64ToBuffer(encryptedB64);
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
  // Default is empty
  branchName: "main",
  folderPath: "assets/",
  deleteLocal: false,
  useEncryption: true
};
var MyPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    // This will hold the decrypted token in memory for the session
    this.decryptedToken = null;
  }
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new GitHubUploaderSettingTab(this.app, this));

    // --- CHANGE 1: REGISTER THE PASTE HANDLER ---
    // This now listens for paste events directly in the editor.
    this.registerEvent(
      this.app.workspace.on("editor-paste", this.handlePaste.bind(this))
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof import_obsidian.TFile) {
          const imageExtensions = ["png", "jpg", "jpeg", "gif", "bmp", "svg"];
          if (imageExtensions.includes(file.extension.toLowerCase())) {
            // This logic is kept for drag-and-drop support
            this.handleImageUpload(file);
          }
        }
      })
    );
  }

  // --- CHANGE 2: ADDED THE `handlePaste` FUNCTION ---
  // This new function processes clipboard events to find and upload images.
  async handlePaste(evt) {
    if (evt.clipboardData === null) {
      return;
    }
    const files = evt.clipboardData.files;
    if (files.length > 0) {
      const imageFile = Array.from(files).find(file => file.type.startsWith("image/"));
      if (imageFile) {
        evt.preventDefault(); // Stop Obsidian from handling the paste
        
        // Create a temporary TFile-like object to pass to the uploader
        const tempFile = {
            name: imageFile.name,
            path: imageFile.name, // Temporary path
            extension: imageFile.name.split('.').pop() || 'png',
            vault: this.app.vault,
            readBinary: () => imageFile.arrayBuffer()
        };
        
        // We cast it to TFile to satisfy the handleImageUpload signature.
        // The uploader only needs name, extension, and readBinary.
        await this.handleImageUpload(tempFile, true);
      }
    }
  }

  // New method to get the token, prompting for password if needed.
  async getDecryptedToken() {
    if (this.decryptedToken) {
      return this.decryptedToken;
    }
    if (this.settings.useEncryption && this.settings.encryptedToken) {
      try {
        const password = await new PasswordPrompt(this.app).open();
        const token = await decrypt(this.settings.encryptedToken, password);
        this.decryptedToken = token;
        return token;
      } catch (e) {
        if (e.message.includes("decryption failed")) {
          new import_obsidian.Notice("Decryption failed. Incorrect password.", 5e3);
        } else if (e.message !== "Password not provided") {
          new import_obsidian.Notice(`Decryption error: ${e.message}`, 5e3);
        }
        return null;
      }
    }
    return null;
  }

  async handleImageUpload(file, isPaste = false) {
    if (!this.settings.githubUser || !this.settings.repoName) {
      new import_obsidian.Notice("GitHub User and Repo Name must be configured.");
      return;
    }
    if (this.settings.useEncryption && !this.settings.encryptedToken) {
      new import_obsidian.Notice("Encryption is enabled, but no token is saved. Please set it in settings.");
      return;
    }
    const token = await this.getDecryptedToken();
    if (this.settings.useEncryption && !token) {
      return;
    }
    const uploadNotice = new import_obsidian.Notice(`Uploading ${file.name} to GitHub...`, 0);
    try {
      const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
      const newFileName = `${timestamp}.${file.extension}`;
      const fileData = await (isPaste ? file.readBinary() : this.app.vault.readBinary(file));

      const base64Data = btoa(new Uint8Array(fileData).reduce((data, byte) => data + String.fromCharCode(byte), ""));
      const filePath = this.settings.folderPath + newFileName;
      const apiUrl = `https://api.github.com/repos/${this.settings.githubUser}/${this.settings.repoName}/contents/${filePath}`;
      const requestBody = {
        message: `feat: Add image '${newFileName}' from Obsidian`,
        content: base64Data,
        branch: this.settings.branchName
      };
      const response = await fetch(apiUrl, {
        method: "PUT",
        headers: {
          "Authorization": `token ${token}`,
          // Use the decrypted token
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
      });
      uploadNotice.hide();
      if (!response.ok) {
        throw new Error(`GitHub API Error: ${(await response.json()).message}`);
      }
      const publicUrl = `https://raw.githubusercontent.com/${this.settings.githubUser}/${this.settings.repoName}/${this.settings.branchName}/${filePath}`;

      if (isPaste) {
          // If it was a paste, we just insert the new URL at the cursor
          const activeView = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
          activeView?.editor.replaceSelection(`![](${publicUrl})`);
      } else {
          // If it was a file creation, we find and replace the link
          await this.replaceLinkInEditor(file.name, publicUrl);
      }

      new import_obsidian.Notice(`${newFileName} uploaded successfully!`);
      if (this.settings.deleteLocal && !isPaste) {
        await this.app.vault.delete(file);
        new import_obsidian.Notice(`Local file ${file.name} deleted.`);
      }
    } catch (error) {
      uploadNotice.hide();
      new import_obsidian.Notice(`Upload failed: ${error.message}`);
      console.error("GitHub Uploader Error:", error);
    }
  }

  // --- CHANGE 3: IMPROVED LINK REPLACEMENT FUNCTION ---
  // This now handles both ![[wikilinks]] and ![](markdown_links)
  async replaceLinkInEditor(fileName, newUrl) {
    setTimeout(() => {
      const activeView = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
      if (!activeView) {
        new import_obsidian.Notice("Error: Could not find an active editor to replace the link.");
        console.error("GitHub Uploader: Cannot find active Markdown view to replace link.");
        return;
      }
      const editor = activeView.editor;
      const doc = editor.getDoc();
      const content = doc.getValue();

      // Escape special characters for regex
      const escapedFileName = fileName.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
      
      // Create regex to find both wikilink and markdown link formats
      const linkRegex = new RegExp(`!\\[\\[${escapedFileName}\\]\\]|!\\[.*?\\]\\(.*?${encodeURIComponent(escapedFileName)}.*?\\)`);

      if (linkRegex.test(content)) {
        const newContent = content.replace(linkRegex, `![](${newUrl})`);
        const cursor = editor.getCursor();
        doc.setValue(newContent);
        editor.setCursor(cursor);
      } else {
        console.warn(`GitHub Uploader: Could not find link for "${fileName}" to replace.`);
        // Don't show a notice for this, as it can be noisy
      }
    }, 100); // A small delay to ensure Obsidian has written the link to the file
  }

  onunload() {
    this.decryptedToken = null;
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
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
    contentEl.createEl("h2", { text: "Enter Master Password" });
    const passwordInput = new import_obsidian.Setting(contentEl).setName("Password").addText((text) => {
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
var GitHubUploaderSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.masterPassword = "";
    this.githubToken = "";
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "GitHub Image Uploader Settings" });
    new import_obsidian.Setting(containerEl).setName("GitHub Username").addText((text) => text.setPlaceholder("your-name").setValue(this.plugin.settings.githubUser).onChange(async (value) => {
      this.plugin.settings.githubUser = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Repository Name").addText((text) => text.setPlaceholder("obsidian-assets").setValue(this.plugin.settings.repoName).onChange(async (value) => {
      this.plugin.settings.repoName = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Branch Name").addText((text) => text.setPlaceholder("main").setValue(this.plugin.settings.branchName).onChange(async (value) => {
      this.plugin.settings.branchName = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Folder Path in Repository").addText((text) => text.setPlaceholder("assets/").setValue(this.plugin.settings.folderPath).onChange(async (value) => {
      this.plugin.settings.folderPath = value.length > 0 && !value.endsWith("/") ? value + "/" : value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Delete Local File After Upload").addToggle((toggle) => toggle.setValue(this.plugin.settings.deleteLocal).onChange(async (value) => {
      this.plugin.settings.deleteLocal = value;
      await this.plugin.saveSettings();
    }));
    containerEl.createEl("h3", { text: "Encryption Settings" });
    new import_obsidian.Setting(containerEl).setName("Enable Encryption").setDesc("Encrypt your GitHub Token. You will be prompted for a password on startup.").addToggle((toggle) => toggle.setValue(this.plugin.settings.useEncryption).onChange(async (value) => {
      this.plugin.settings.useEncryption = value;
      if (!value) {
        this.plugin.settings.encryptedToken = "";
      }
      await this.plugin.saveSettings();
      this.display();
    }));
    if (this.plugin.settings.useEncryption) {
      new import_obsidian.Setting(containerEl).setName("Master Password").setDesc("Set a password to encrypt your token. This is NOT saved.").addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("Enter password to set/change token");
        text.onChange((value) => {
          this.masterPassword = value;
        });
      });
      new import_obsidian.Setting(containerEl).setName("GitHub Personal Access Token").setDesc("Enter your PAT here. It will be encrypted on save.").addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("ghp_... (paste new token here)");
        text.onChange((value) => {
          this.githubToken = value;
        });
      });
      new import_obsidian.Setting(containerEl).addButton((button) => button.setButtonText("Save Encrypted Token").setCta().onClick(async () => {
        if (!this.masterPassword || !this.githubToken) {
          new import_obsidian.Notice("Please provide both a Master Password and a Token.");
          return;
        }
        try {
          const encrypted = await encrypt(this.githubToken, this.masterPassword);
          this.plugin.settings.encryptedToken = encrypted;
          await this.plugin.saveSettings();
          new import_obsidian.Notice("Token has been encrypted and saved!");
        } catch (e) {
          new import_obsidian.Notice(`Encryption failed: ${e.message}`);
        }
      }));
    }
  }
};
