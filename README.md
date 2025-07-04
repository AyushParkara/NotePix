# NotePix - GitHub Image Uploader

[![Built for Obsidian](https://img.shields.io/badge/Built%20for-Obsidian-7B68EE.svg?style=for-the-badge)](https://obsidian.md)
[![Release Version](https://img.shields.io/github/v/release/AyushParkara/NotePix?style=for-the-badge&sort=semver)](https://github.com/AyushParkara/NotePix/releases/)

NotePix automatically uploads images, screenshots, and other assets from your Obsidian vault to a designated GitHub repository. It then seamlessly replaces the local link with a fast, CDN-hosted URL, keeping your vault lightweight and portable.

<!--
IMPORTANT: RECORD A GIF DEMO!
1. Record your screen showing you pasting an image into Obsidian.
2. Show the "Uploading..." notice.
3. Show the local link ![[...]] being replaced by the CDN link ![](...).
4. Upload the GIF to your GitHub repo (e.g., in an 'assets' folder).
5. Replace the placeholder link below with your GIF's link.
-->
![NotePix Demo GIF](https://raw.githubusercontent.com/AyushParkara/NotePix/main/assets/notepix-demo.gif)

## ✨ Features

-   **Seamless Automation**: Just paste or drag an image into a note. NotePix handles the rest.
-   **Secure Token Storage**: Your GitHub Personal Access Token (PAT) is **never** stored in plain text. It is encrypted using AES-GCM, and you are prompted for a master password to decrypt it once per session.
-   **Fast CDN Links**: Uses [jsDelivr](https://www.jsdelivr.com/) to serve images from your GitHub repository, ensuring fast load times anywhere in the world.
-   **Customizable**: Configure the target repository, branch, and folder path to fit your workflow.
-   **Clean Up**: Optionally delete the local image file after a successful upload to save space.
-   **Mobile Compatible**: Works on both Obsidian Desktop and Mobile.

## ⚙️ How it Works

1.  **Paste an Image**: When you paste an image into a note, Obsidian creates a local file.
2.  **Automatic Upload**: NotePix detects this new file, uploads it to your configured GitHub repository, and names it with a unique timestamp.
3.  **Link Replacement**: The local `![[image.png]]` embed is automatically replaced with the public jsDelivr CDN markdown link `![](image-url)`.

If encryption is enabled, the plugin will prompt you for your master password the first time you upload an image in a session to securely decrypt your GitHub token.

## 🚀 Setup Guide

Follow these steps to get NotePix running.

### Step 1: Create a GitHub Repository

First, you need a public GitHub repository to store your images.

1.  Go to [GitHub](https://github.com) and create a **new public repository**. You can name it anything you like (e.g., `obsidian-assets`, `my-notes-images`).
2.  You do not need to initialize it with a README or any other files.

### Step 2: Generate a GitHub Personal Access Token (PAT)

NotePix needs a token to be able to upload files to your repository.

1.  Go to your GitHub **Settings**.
2.  Navigate to **Developer settings** > **Personal access tokens** > **Tokens (classic)**.
3.  Click **"Generate new token"** and select **"Generate new token (classic)"**.
4.  Give the token a descriptive name (e.g., `obsidian-notepix-token`).
5.  Set the **Expiration** as desired (e.g., 90 days or "No expiration").
6.  Under **Select scopes**, check the box for **`repo`**. This is the only permission required.
7.  Click **"Generate token"** at the bottom.
8.  **Immediately copy the token!** You will not be able to see it again.

### Step 3: Install and Configure the Plugin

1.  Install NotePix from the Obsidian **Community Plugins** browser.
2.  Enable the plugin in your settings.
3.  Open the NotePix settings tab and fill in the details:

| Setting                      | Description                                                                                             | Example                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------- |
| **GitHub Username**            | Your GitHub username (case-sensitive).                                                                  | `AyushParkara`             |
| **Repository Name**            | The name of the public repository you created in Step 1.                                                | `obsidian-assets`          |
| **Branch Name**                | The branch to upload files to.                                                                          | `main` or `master`         |
| **Folder Path in Repository**  | The directory inside your repo to store images. Leave blank for the root. A `/` is added automatically. | `assets/`                  |
| **Delete Local File**        | If enabled, the original image file is deleted from your vault after a successful upload.               | `true` / `false`           |

#### Encryption Setup (Highly Recommended)

1.  Toggle on **"Enable Encryption"**.
2.  Enter a strong, memorable password in the **"Master Password"** field. **This password is not saved anywhere.**
3.  Paste the **GitHub PAT** you generated in Step 2 into the "GitHub Personal Access Token" field.
4.  Click **"Save Encrypted Token"**. A notice will confirm it has been saved securely.

You are all set! The next time you paste an image, NotePix will handle the upload.

## 🙏 Support

This plugin is created by [Ayush Parkara](https://github.com/AyushParkara). If you find it useful and want to show your appreciation, you can support me here:

<a href="https://www.paypal.com/paypalme/AyushParkara" target="_blank"><img src="https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png" alt="Paypal Me" style="height: 41px !important;width: 174px !important;box-shadow: 0px 3px 2px 0px rgba(190, 190, 190, 0.5) !important;-webkit-box-shadow: 0px 3px 2px 0px rgba(190, 190, 190, 0.5) !important;" ></a>

## 📄 License

This plugin is released under the MIT License.
