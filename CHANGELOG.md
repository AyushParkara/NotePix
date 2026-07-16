# Changelog

All notable changes to NotePix are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.1] — 2026-07-15

Fully backward-compatible. New options are opt-in and default off.

### Added
- **Fix image links to working format** — a command that auto-detects your repo mode and
  rewrites the current note's image links to the format that actually renders: private →
  internal v2 links; public → jsDelivr CDN (if enabled) or raw GitHub links. Handy after
  a repo's visibility changes.
- **Portable local folders** (opt-in) — designate folders whose notes keep their images
  **local** (never uploaded): images are named after the note, stored in a `photos`
  subfolder inside the folder, and linked with a relative path so the whole folder can be
  moved without breaking images. Configurable subfolder name and link format
  (relative Markdown or wikilink).

### Fixed
- **New tokens now take effect immediately** — saving a new/updated token no longer
  requires restarting Obsidian; the old cached token is cleared right away.
- **Images stop being stuck as "broken"** — when the token changes, the image caches are
  cleared and the current note re-fetches, so previously-failed images recover without a
  restart.
- **Clearer error when a token can't access the repo** — instead of only cryptic console
  404s, NotePix now shows a notice suggesting you check the token's repository access and
  `Contents` permission.

## [1.5.0] — 2026-07-03

A large, fully backward-compatible feature release. All new options are **off by
default**, so existing setups behave exactly as before until you opt in.

### Added
- **Upload all local images in current note** — upload every image already embedded in
  a note in one pass. Uploads first, then rewrites the note in a single pass (no
  clobbered links), and targets the correct note even if you switch away mid-upload.
- **Private images in Live Preview** — private-repo images now render while editing, not
  just in Reading View. Fetched in-memory; no temporary files.
- **Delete image (GitHub + note)** — right-click an image (editor or rendered) to delete
  the file from GitHub and remove its link, with a multi-note safety guard
  (skip / this note only / everywhere).
- **Multi-select delete** — tick several of a note's images from a checklist and delete
  them together.
- **Find orphaned images** — review repo images no note or canvas references anymore and
  delete the ones you choose (report-only; scans `.md` and `.canvas`).
- **Right-click Copy** — Copy image (private or public) and Copy URL (public/CDN only).
- **Optional jsDelivr CDN** for public repos, with commands to convert a note's links
  between raw and CDN.
- **Optional note-path storage layout** and **optional heading/note-based filenames**
  (e.g. `MyNote-1.png`).

### Fixed
- GitHub delete failing with "no sha / unreadable response", by using Obsidian's
  `requestUrl` and computing the git blob SHA directly from file bytes when needed.
- Faithful filename preservation for captions and sizes (e.g. `![[img.png|200]]` →
  `![|200](url)`), and correct URL encoding for filenames with spaces, unicode, and
  parentheses.

## [1.4.3] — 2026-03-05

### Added
- Safe legacy link migration from `obsidian://notepix/<path>` to the v2 format, applied
  only after successful repo resolution.
- Token-based same-user repo discovery for legacy image resolution.
- Repo candidate limits and cooldowns to reduce repeated checks and latency.
- Source-note-aware replacement fallback to avoid active-editor timing misses.
- mtime-safe migration writes to avoid overwriting newer edits.

## [1.4.2] — 2026-03-05

### Fixed
- Deterministic link replacement when filenames repeat (no longer replaces older
  occurrences).
- Large-image upload stability and performance (replaced expensive base64 construction).
- Malformed NotePix link sanitization and render robustness in preview flows.

### Added
- Same-user cross-repo raw-link rendering fallback for old links in preview.

## [1.4.1] — 2026-03-03

### Added
- Repo Mode Intelligence with Auto / Public / Private behavior.
- 3-option mismatch modal: Use Auto Mode, Switch to Private, Keep Public.
- Fallback rendering for old raw GitHub image links when the repo is private.
- Self-describing private links for multi-repo-safe rendering.

### Changed
- Token UX improved to avoid repeated render-time notices while still supporting secure
  prompts when needed.

## [1.4.0] — 2025-11-17

### Added
- Reliable mobile uploads (Android/iOS), including via the attachment button.
- Attachment-folder integration on mobile (auto-picks up screenshots).
- "Ask before upload" now also prompts for attachment-button images on mobile.

### Changed
- Mobile logic refactored to reuse the same encryption, token, and upload engine as
  desktop; link replacement on mobile is now filename-aware and more resilient to
  Android editor timing.

### Fixed
- Local image files are deleted only after the note link is successfully updated,
  avoiding broken references.

## [1.3.0] — 2025-10-23

### Added
- Optional encryption / flexible token management: encrypted (master password) **or**
  plain-token mode, via an "Enable Encryption" toggle. Unified `getToken()` for both.
- Smart hover detection: password prompts only in main document views, not during hover
  or page previews.

## [1.2.0] — 2025-10-15

### Added
- Pasted-image upload behavior setting: "Always Upload" (default) or "Ask Before
  Uploading".
- Configurable local image folder for pastes you keep in the vault (ignored by
  auto-upload).

### Fixed
- Prevent memory leaks by revoking created blob URLs on unload.
- No accidental auto-uploads from the local image folder.
- Clearer decryption error handling on wrong password.

## [1.1.0] — 2025-09-01

### Added
- Private repository support (set Repository Visibility to Private); images fetched
  on-the-fly in Reading View.
- Paste-to-upload: paste images directly from the clipboard, no local save needed.

### Changed
- Link replacement reliably handles both `![[wikilinks]]` and `![](markdown links)`.

## [1.0.0] — 2025-07-04

### Added
- Initial release: detects image creation in the vault, uploads to a GitHub repo, and
  returns a hosted link.
- Encrypted GitHub token storage (master password).
- Optional auto-delete of local images after upload.

[1.5.1]: https://github.com/AyushParkara/NotePix/releases/tag/1.5.1
[1.5.0]: https://github.com/AyushParkara/NotePix/releases/tag/1.5.0
[1.4.3]: https://github.com/AyushParkara/NotePix/releases/tag/1.4.3
[1.4.2]: https://github.com/AyushParkara/NotePix/releases/tag/1.4.2
[1.4.1]: https://github.com/AyushParkara/NotePix/releases/tag/1.4.1
[1.4.0]: https://github.com/AyushParkara/NotePix/releases/tag/1.4.0
[1.3.0]: https://github.com/AyushParkara/NotePix/releases/tag/1.3.0
[1.2.0]: https://github.com/AyushParkara/NotePix/releases/tag/1.2.0
[1.1.0]: https://github.com/AyushParkara/NotePix/releases/tag/1.1.0
[1.0.0]: https://github.com/AyushParkara/NotePix/releases/tag/1.0.0
