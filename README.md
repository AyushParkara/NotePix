# NotePix - GitHub Image Uploader

[![Built for Obsidian](https://img.shields.io/badge/Built%20for-Obsidian-7B68EE.svg?style=for-the-badge)](https://obsidian.md)
[![Release Version](https://img.shields.io/github/v/release/AyushParkara/NotePix?style=for-the-badge&sort=semver)](https://github.com/AyushParkara/NotePix/releases/)

NotePix automatically uploads images, screenshots, and other assets from your Obsidian vault to a designated GitHub repository. It then seamlessly replaces the local link with a GitHub-hosted URL for public repos, or a secure internal link for private repos, keeping your vault lightweight and portable.

![NotePix Demo GIF](https://raw.githubusercontent.com/AyushParkara/NotePix/main/assets/notepix-demo.gif)

## ✨ Features

-   **Seamless Automation**: Just paste or drag an image into a note. NotePix handles the rest.
-   **Private Repository Support**: Securely store your images in a private GitHub repository. NotePix fetches and displays them on-the-fly in Reading View.
-   **Smart Hover Detection**: Password prompts only appear in main document views. Hover previews and page previews work seamlessly without interrupting your workflow.
-   **Secure Token Storage**: Your GitHub Personal Access Token (PAT) is **never** stored in plain text. It is encrypted using AES-GCM, and you are prompted for a master password to decrypt it once per session.
-   **GitHub-Hosted Links**: For public repositories, NotePix uses direct GitHub links to serve images.
-   **Customizable**: Configure the target repository, branch, and folder path to fit your workflow.
-   **Clean Up**: Optionally delete the local image file after a successful upload to save space.
-   **Mobile Compatible**: Works on both Obsidian Desktop and Mobile.

## ⚙️ How it Works

The process differs slightly depending on whether your repository is public or private.

#### For Public Repositories:
1.  **Paste an Image**: When you paste an image, Obsidian creates a local file.
2.  **Automatic Upload**: NotePix detects this new file and uploads it to your configured **public** GitHub repository.
3.  **Link Replacement**: The local `![[image.png]]` embed is automatically replaced with a public GitHub markdown link `![](https://raw.githubusercontent.com/...)`. This link works everywhere.

#### For Private Repositories:
1.  **Paste an Image**: The upload process is identical. The image is uploaded to your **private** GitHub repository.
2.  **Link Replacement**: The local link is replaced with a special internal link, like `![](obsidian://notepix/assets/image.png)`.
3.  **Editor View**: This special link will appear **broken** in Live Preview or Source Mode, as the editor cannot access private files.
4.  **Reading View**: When you switch to **Reading View**, NotePix intercepts this link, uses your secure token to fetch the image directly from your private repo, and displays it seamlessly.
5.  **Hover Previews**: When you hover over links to notes with private images, the images load automatically without password prompts, using your cached session token.

If encryption is enabled, the plugin will prompt you for your master password **once per session** when you first open a note with private images. After that, all subsequent views (including hover previews and page previews) will use the cached token without any prompts.

## 🚀 Setup Guide

Follow these steps to get NotePix running.

### Step 1: Create a GitHub Repository (Public or Private)

First, you need a GitHub repository to store your images. This can now be **public** or **private**.

1.  Go to [GitHub](https://github.com) and create a **new repository**.
2.  You can name it anything you like (e.g., `obsidian-assets`, `my-notes-images`).
3.  Choose the visibility: **Public** or **Private**.

### Step 2: Generate a GitHub Personal Access Token (PAT)

NotePix needs a token to be able to upload files to your repository.

1.  Go to your GitHub **Settings**.
2.  Navigate to **Developer settings** > **Personal access tokens** > **Tokens (classic)**.
3.  Click **"Generate new token"** and select **"Generate new token (classic)"**.
4.  Give the token a descriptive name (e.g., `obsidian-notepix-token`).
5.  Set the **Expiration** as desired (e.g., 90 days or "No expiration").
6.  Under **Select scopes**, check the box for **`repo`**. This is the only permission required for both public and private repos.
7.  Click **"Generate token"** at the bottom.
8.  **Immediately copy the token!** You will not be able to see it again.

### Step 3: Install and Configure the Plugin

1.  Install NotePix from the Obsidian **Community Plugins** browser.
2.  Enable the plugin in your settings.
3.  Open the NotePix settings tab and fill in the details:

| Setting | Description | Example |
| :--- | :--- | :--- |
| **GitHub Username** | Your GitHub username (case-sensitive). | `AyushParkara` |
| **Repository Name** | The name of the repository you created in Step 1. | `obsidian-assets` |
| **Repository Visibility** | Choose 'Public' for GitHub-hosted links or 'Private' for secure, on-the-fly image loading. | `Public` / `Private` |
| **Branch Name** | The branch to upload files to. | `main` or `master` |
| **Folder Path in Repository** | The directory inside your repo to store images. A `/` is added automatically. | `assets/` |
| **Delete Local File** | If enabled, the original image file is deleted from your vault after a successful upload. | `true` / `false` |

#### Encryption Setup (Highly Recommended)

1.  Toggle on **"Enable Encryption"**.
2.  Enter a strong, memorable password in the **"Master Password"** field. **This password is not saved anywhere.**
3.  Paste the **GitHub PAT** you generated in Step 2 into the "GitHub Personal Access Token" field.
4.  Click **"Save Encrypted Token"**. A notice will confirm it has been saved securely.

You are all set! The next time you paste an image, NotePix will handle the upload according to your settings.



## 🙏 Support

This plugin is created by [Ayush Parkara](https://github.com/AyushParkara). If you find it useful and want to show your appreciation, you can support me here:

<a href="https://www.paypal.com/paypalme/AyushParkara" target="_blank"><img src="https://www.paypalobjects.com/en_US/i/btn/btn_donateCC_LG.gif" alt="Donate with PayPal"></a>

## 📄 License

This plugin is released under the MIT License.
