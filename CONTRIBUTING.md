# Contributing to NotePix

Thanks for your interest in improving NotePix! Contributions of all kinds are
welcome — bug reports, feature ideas, documentation fixes, and code.

## Ways to contribute

- **🐞 Report a bug** — open a [Bug report](https://github.com/AyushParkara/NotePix/issues/new?template=bug_report.yml).
- **✨ Suggest a feature** — open a [Feature request](https://github.com/AyushParkara/NotePix/issues/new?template=feature_request.yml).
- **💬 Ask a question / discuss ideas** — use [Discussions](https://github.com/AyushParkara/NotePix/discussions).
- **🔧 Submit a fix or feature** — see the development setup below.

## Before you start coding

For anything beyond a small fix, **please open an issue first** so we can agree on the
approach before you invest time. This avoids duplicated or wasted work.

## Development setup

NotePix is a single `main.js` file at the repo root — this is what Obsidian loads, and
it's edited directly (there is no separate build step). `manifest.json` and `styles.css`
sit alongside it.

To test a change locally in a real vault:

1. Create a test vault (never test against your real notes).
2. Copy `main.js`, `manifest.json`, and `styles.css` into
   `<vault>/.obsidian/plugins/notepix/`.
3. In Obsidian: **Settings → Community plugins → Reload** (or toggle the plugin off/on).
4. Use **Ctrl/Cmd+Shift+I** to open the developer console and watch for `NotePix:` logs.

## Coding guidelines

- **Match the surrounding style** — the codebase uses clear names, section comments,
  and defensive error handling. Keep that bar.
- **Never break backward compatibility silently.** New behavior should be opt-in and
  default to the existing behavior (this is a stated project principle — all new
  options in recent releases default OFF).
- **Security is critical.** Never log tokens or passwords. Never weaken the encryption
  path. If a change touches token handling, call it out explicitly in the PR.
- **Test on both desktop and mobile** if your change touches paste, file handling, or
  network requests — mobile has historically been the source of edge cases.
- Prefer Obsidian's `requestUrl` over raw `fetch` for GitHub API calls (better
  cross-platform/CORS behavior).

## Pull requests

1. Fork the repo and create a branch (`fix/short-description` or `feat/short-description`).
2. Make your change; keep it focused (one logical change per PR).
3. Describe **what** changed and **why**, and how you tested it (platform, steps).
4. Link the issue it resolves (`Closes #123`).

## Reporting security issues

Do **not** open a public issue for security vulnerabilities. See
[SECURITY.md](SECURITY.md) for private reporting.

## Code of Conduct

By participating, you agree to uphold our [Code of Conduct](CODE_OF_CONDUCT.md).

Thank you for helping make NotePix better! 🙏
