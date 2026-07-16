# Security Policy

NotePix handles a **GitHub Personal Access Token (PAT)** with write access to a
repository, so security is a first-class concern. This document explains how the
plugin protects your credentials and how to report a vulnerability.

## How NotePix stores your token

NotePix offers two modes:

### Encrypted mode (default, recommended)
- Your PAT is encrypted with **AES-GCM (256-bit)**.
- The encryption key is derived from your **master password** using
  **PBKDF2 (100,000 iterations, SHA-256)**.
- A fresh random **salt (16 bytes)** and **IV (12 bytes)** are generated for every
  encryption, so the same token never produces the same ciphertext.
- **Your master password is never stored** — anywhere. It is held only in memory
  while you type it, used to derive the key, and discarded.
- The decrypted token lives **only in memory for the current session** and is
  cleared when the plugin unloads.

### Plain mode (optional, not recommended)
- If you disable encryption, the PAT is stored **in plain text** in the plugin's
  `data.json`.
- ⚠️ `data.json` may be synchronized to other devices or cloud storage depending on
  your setup. A plaintext PAT could be exposed there. Only use plain mode if you
  understand and accept this tradeoff. The settings UI warns you when this mode is on.

## Recommended token scope

For the smallest blast radius if a token is ever leaked, prefer a
**fine-grained personal access token** scoped to **only your image repository**:

- Repository access: **Only select repositories** → your image repo.
- Permissions: **Contents → Read and write**.

A classic PAT with the `repo` scope also works, but it grants access to **all** your
repositories — a much larger risk if leaked. Use fine-grained tokens when possible.

## Good practices

- Set a **token expiration** (e.g. 90 days) and rotate it.
- Never paste your PAT into a note, issue, or Discord message.
- Use a **dedicated repository** for images, separate from private/source repos.
- Keep encrypted mode ON.

## Reporting a vulnerability

If you discover a security vulnerability in NotePix, **please do not open a public
issue.** Instead:

- Use **GitHub's private vulnerability reporting**:
  <https://github.com/AyushParkara/NotePix/security/advisories/new>, or
- Contact the maintainer directly via the profile at
  <https://github.com/AyushParkara>.

Please include:
- A description of the vulnerability and its impact.
- Steps to reproduce.
- The NotePix version and platform (desktop/mobile, OS).

I aim to acknowledge reports within **7 days** and to address confirmed issues as
quickly as is practical for a solo-maintained project. Responsible disclosure is
greatly appreciated — thank you for helping keep NotePix users safe.

## Supported versions

Security fixes are applied to the **latest released version**. Please update to the
newest version before reporting, in case the issue is already resolved.
