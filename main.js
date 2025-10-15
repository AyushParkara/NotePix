var import_obsidian = require("obsidian");
var path = require("path");

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
  // Default is empty
  branchName: "main",
  folderPath: "assets/",
  deleteLocal: false,
  useEncryption: true,
  repoVisibility: 'public',
  uploadOnPaste: 'always',
  localImageFolder: 'notepix-local'
};
var MyPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    // This will hold the decrypted token in memory for the session
    this.decryptedToken = null;
    this.isPromptingForPassword = false;
  }
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new GitHubUploaderSettingTab(this.app, this));

    // Initialize an in-memory cache for private images
    this.imageCache = new Map();

    // Register the processor that will handle our custom image URLs
    this.registerMarkdownPostProcessor(this.postProcessImages.bind(this));

    // --- Existing event handlers ---
    this.registerEvent(
      this.app.workspace.on("editor-paste", this.handlePaste.bind(this))
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof import_obsidian.TFile) {
          const imageExtensions = ["png", "jpg", "jpeg", "gif", "bmp", "svg"];
          if (!imageExtensions.includes(file.extension.toLowerCase())) {
            return;
          }

          // Ignore any file created inside the local-only images folder
          const filePathNorm = file.path.replace(/\\/g, "/");
          const folderNorm = (this.settings.localImageFolder || "notepix-local")
            .replace(/\\/g, "/")
            .replace(/^\/+|\/+$/g, "");

          if (filePathNorm.startsWith(folderNorm + "/")) {
            // This is an intentionally local-only image; do not auto-upload
            return;
          }

          this.handleImageUpload(file);
        }
      })
    );
  }

  onunload() {
    // Clear the decrypted token from memory
    this.decryptedToken = null;

    // IMPORTANT: Revoke all created blob URLs to prevent memory leaks
    if (this.imageCache) {
      this.imageCache.forEach(url => URL.revokeObjectURL(url));
      this.imageCache.clear();
    }
  }
  // --- CHANGE 2: ADDED THE `handlePaste` FUNCTION ---
  // This new function processes clipboard events to find and upload images.
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
    const tempFile = {
      name: imageFile.name,
      path: imageFile.name, // Temporary path
      extension: imageFile.name.split('.').pop() || 'png',
      vault: this.app.vault,
      readBinary: () => imageFile.arrayBuffer()
    };
    await this.handleImageUpload(tempFile, true);
  }

  async saveImageLocally(imageFile) {
    const arrayBuffer = await imageFile.arrayBuffer();
    const activeView = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    if (!activeView) {
      new import_obsidian.Notice("Cannot save image: No active editor view.");
      return;
    }

    // Normalize folder setting to a clean, vault-relative POSIX path
    const folderPath = (this.settings.localImageFolder || 'notepix-local')
      .replace(/\\/g, "/")
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
  }  // New method to get the token, prompting for password if needed.
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
        if (e.message.includes("decryption failed")) {
          new import_obsidian.Notice("Decryption failed. Incorrect password.", 5e3);
        } else if (e.message !== "Password not provided") {
          new import_obsidian.Notice(`Decryption error: ${e.message}`, 5e3);
        }
        return null;
      } finally {
        this.isPromptingForPassword = false;
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
      const filePath = path.posix.join(this.settings.folderPath, newFileName);
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
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
      });
      uploadNotice.hide();
      if (!response.ok) {
        throw new Error(`GitHub API Error: ${(await response.json()).message}`);
      }

      let finalUrl;
      // Check the repository visibility setting
      if (this.settings.repoVisibility === 'private') {
        // For private repos, create our custom URL for the post-processor to handle.
        finalUrl = `obsidian://notepix/${filePath}`;
        new import_obsidian.Notice("Private image link created.");
      } else {
        // For public repos, use the standard raw GitHub URL.
        finalUrl = `https://raw.githubusercontent.com/${this.settings.githubUser}/${this.settings.repoName}/${this.settings.branchName}/${filePath}`;
      }

      if (isPaste) {
        const activeView = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
        activeView?.editor.replaceSelection(`![](${finalUrl})`);
      } else {
        await this.replaceLinkInEditor(file.name, finalUrl);
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

  // In main.js, inside the MyPlugin class (add this new function)

  async postProcessImages(element, context) {
    this.isHandlingAction = true;
    try {
      const images = element.findAll("img");
      if (images.length === 0) {
        return;
      }

      const token = await this.getDecryptedToken();
      if (this.settings.useEncryption && !token) {
        // Can't process images without a token
        return;
      }

      for (const img of images) {
        const src = img.getAttribute("src");
        if (!src || !src.startsWith("obsidian://notepix/")) {
          continue;
        }

        const imagePath = src.substring("obsidian://notepix/".length);

        const imagePathWithForwardSlashes = imagePath.replace(/\\/g, "/");
        // 1. Check if the image is already in our cache
        if (this.imageCache.has(imagePathWithForwardSlashes)) {
          img.src = this.imageCache.get(imagePathWithForwardSlashes);
          continue;
        }

        // 2. If not cached, fetch it from GitHub
        try {
          const apiUrl = `https://api.github.com/repos/${this.settings.githubUser}/${this.settings.repoName}/contents/${imagePathWithForwardSlashes}`;

          const response = await fetch(apiUrl, {
            method: "GET",
            headers: {
              "Authorization": `token ${token}`,
              // Use this header to get the raw file content directly
              "Accept": 'application/vnd.github.v3.raw',
            }
          });

          if (!response.ok) {
            console.error(`NotePix: Failed to fetch private image ${imagePath}. Status: ${response.status}`);
            // Optional: set a 'broken image' icon
            img.src = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWJhbiI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48bGluZSB4MT0iNC45MyIgeTE9IjQuOTMiIHgyPSIxOS4wNyIgeTI9IjE5LjA3Ii8+PC9zdmc+";
            continue;
          }

          const imageBlob = await response.blob();
          const blobUrl = URL.createObjectURL(imageBlob);

          // 3. Cache the new blob URL and set the image src
          this.imageCache.set(imagePath, blobUrl);
          img.src = blobUrl;

        } catch (error) {
          console.error("NotePix: Error processing private image:", error);
        }
      }
    } finally {
      this.isHandlingAction = false;
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
    contentEl.createEl("h2", { text: "Enter master password" });
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
    new import_obsidian.Setting(containerEl).setName("GitHub username").addText((text) => text.setPlaceholder("your-name").setValue(this.plugin.settings.githubUser).onChange(async (value) => {
      this.plugin.settings.githubUser = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Repository name").addText((text) => text.setPlaceholder("obsidian-assets").setValue(this.plugin.settings.repoName).onChange(async (value) => {
      this.plugin.settings.repoName = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl)
      .setName("Repository visibility")
      .setDesc("Set this to 'private' if you are using a private repository.")
      .addDropdown(dropdown => dropdown
        .addOption('public', 'Public')
        .addOption('private', 'Private')
        .setValue(this.plugin.settings.repoVisibility || 'public')
        .onChange(async (value) => {
          this.plugin.settings.repoVisibility = value;
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

    new import_obsidian.Setting(containerEl)
      .setName("Local image folder")
      .setDesc("The folder where images will be saved when you choose not to upload them.")
      .addText(text => text
        .setPlaceholder("notepix-local")
        .setValue(this.plugin.settings.localImageFolder)
        .onChange(async (value) => {
          this.plugin.settings.localImageFolder = value;
          await this.plugin.saveSettings();
        }));

    new import_obsidian.Setting(containerEl).setName("Encryption").setHeading();
    new import_obsidian.Setting(containerEl).setName("Enable encryption").setDesc("Encrypt your GitHub Token. You will be prompted for a password on startup.").addToggle((toggle) => toggle.setValue(this.plugin.settings.useEncryption).onChange(async (value) => {
      this.plugin.settings.useEncryption = value;
      if (!value) {
        this.plugin.settings.encryptedToken = "";
      }
      await this.plugin.saveSettings();
      this.display();
    }));
    if (this.plugin.settings.useEncryption) {
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
          await this.plugin.saveSettings();
          new import_obsidian.Notice("Token has been encrypted and saved!");
        } catch (e) {
          new import_obsidian.Notice(`Encryption failed: ${e.message}`);
        }
      }));
    }
  }
};
module.exports = MyPlugin;
