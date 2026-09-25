<div align="center">

<img src="src-tauri/icons/zhiye.svg" width="88" height="88" alt="Zhiye">

# Zhiye · 织页

**Weave scattered web pages into readable knowledge.**

A single-user, local-first knowledge base for the open web. Paste a public page URL and Zhiye keeps the article, its
source and an editable Markdown copy — search, folders, the knowledge map, backups and optional AI derivations all
run on your own machine.

[![release](https://img.shields.io/github/v/release/SaraiNoQ/web-knowledge-set?style=flat-square&label=release&color=bd412c)](https://github.com/SaraiNoQ/web-knowledge-set/releases/latest)
[![license](https://img.shields.io/github/license/SaraiNoQ/web-knowledge-set?style=flat-square&color=2f6f4f)](LICENSE)
![platform](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Apple%20Silicon-4a4439?style=flat-square)
![stack](https://img.shields.io/badge/Tauri%202%20%C2%B7%20React%2019%20%C2%B7%20TypeScript%20%C2%B7%20SQLite-4a4439?style=flat-square)

[简体中文](README.md) · [**English**](README.en.md)

[Download](https://github.com/SaraiNoQ/web-knowledge-set/releases/latest) · [User guide (中文)](docs/README.md) · [Feature ledger (中文)](docs/FEATURES.md) · [Security](docs/SECURITY.md)

</div>

> The application interface and the full documentation are currently Chinese-only. The English README is a summary;
> `docs/` is the source of truth.

![The Zhiye workbench: Markdown source beside a live preview](docs/assets/workbench.png)

## Design stance

Web pages disappear, bookmarks do not keep the text, and read-later services turn your reading history into their
data. Zhiye does one thing: **turn a page worth keeping into a file you own.**

- **Local-first.** SQLite is the single source of truth; page snapshots and offline images live in the same knowledge
  base directory. Everything stays readable offline.
- **No account.** No sign-in, no cloud sync, no telemetry, no crash reporting.
- **Portable format.** The body is always editable Markdown, exportable per article, as a whole library, or as a
  portable knowledge package.
- **AI is an opt-in switch.** Off by default; when enabled you see the exact payload before every send, and desktop
  keys go into the macOS keychain.

## What it does

| Capability | Detail |
| --- | --- |
| **Capture public pages** | Reads the article directly first, falling back to an isolated Chromium when scripts are required. Retry, pause the queue, or re-extract from an existing snapshot. |
| **Read and edit** | Markdown editing with live preview, `$…$` / `$$…$$` LaTeX, autosave, revision history and conflict protection. |
| **Organize and search** | One-level folders, tags, multi-select collections, favorites, archive, trash, and Chinese/English title and body search. |
| **Knowledge map** | Articles, papers and folder membership laid out as a draggable graph; dashed semantic links require a separately configured embedding service. |
| **Page-by-page papers** | Import from arXiv or a local PDF, get per-page original blocks with Chinese translations, and edit or save any page. |
| **Browser clipping** | Chrome / Firefox extensions pair once, then save the current tab as Markdown back to your machine. |
| **Migration** | Per-article or whole-library Markdown, portable knowledge ZIP, Netscape bookmarks, and verified full backups with restore. |
| **Optional AI** | Summaries, outlines, keywords, tag suggestions, free-form chat and structure-preserving translation. Results are stored separately and never overwrite the original. |

![The knowledge map: articles, papers and folder membership](docs/assets/knowledge-map.png)

## Quick start

### macOS desktop

Download the latest `Zhiye_*_aarch64.dmg` from [Releases](https://github.com/SaraiNoQ/web-knowledge-set/releases/latest).

> [!IMPORTANT]
> The desktop build is currently **ad-hoc signed, not notarized by Apple, and has no auto-update**. On first launch,
> allow it under System Settings → Privacy & Security.

### Local web mode

Requires Node `24.19.0` (see `.node-version`).

```sh
pnpm install --frozen-lockfile
pnpm build
KB_DATA_DIR=/path/to/your/library pnpm start
```

The service binds `127.0.0.1` only and prints a one-shot URL on startup. The data directory holds the database, page
snapshots and offline images.

### Browser extension

Install `dist/extensions/` (produced by `pnpm build`) unpacked in Chrome, or load it temporarily in Firefox. Current
version `0.3.7`, **not published to any extension store**.

## Privacy and boundaries

- No account, cloud sync, telemetry or crash uploads; diagnostics stay local and are never uploaded automatically.
- Capture connects only to public addresses you submit, refusing loopback, private, link-local and other non-public
  ranges.
- Logged-in pages, cookie import, paywalls, CAPTCHA bypass, intranet pages and whole-site crawling are not supported.
- No mobile app, no Windows / Linux release, no collaboration. Folders are one level deep — use tags or collections
  for cross-cutting groups.
- Semantic scores are model similarity, not accuracy; map edges mean folder membership or explicitly labelled
  semantic suggestions.

See [PRIVACY.md](docs/PRIVACY.md) and [SECURITY.md](docs/SECURITY.md) for the full statements.

## Cloud web (optional)

The same contract also has a Cloudflare Worker implementation (Workers Static Assets + D1 + R2 + Queues + Browser
Run), deployed at `zhiye.sarainoq.cn` behind Cloudflare Access and used only by the author today.

The local library and the cloud web are **two independent datasets**: folder semantics match, but nothing syncs
automatically — cross-device moves are still explicit export and import. See [CLOUDFLARE.md](docs/CLOUDFLARE.md).

## Stack

Tauri 2 · React 19 · TypeScript · Vite · `node:sqlite` (built into Node 24) · CodeMirror 6 · KaTeX · pdf.js ·
react-force-graph · Cloudflare Workers / D1 / R2 / Queues · Playwright

## Documentation

| Document | Contents |
| --- | --- |
| [docs/README.md](docs/README.md) | User guide: daily flow, shortcuts, data and backups, current limits |
| [docs/FEATURES.md](docs/FEATURES.md) | Feature ledger with acceptance boundaries |
| [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md) | Roadmap, milestones and release gates |
| [docs/KNOWLEDGE_MAP.md](docs/KNOWLEDGE_MAP.md) · [docs/PAPER_READER.md](docs/PAPER_READER.md) | Knowledge map and paper reader specifics |
| [docs/SUPPORT.md](docs/SUPPORT.md) | Troubleshooting, diagnostics, security updates and rollback |

## Contributing

Development, testing, packaging and releases all happen on a controlled build machine; the local workspace is for
editing and syncing source only. The full rules are in [AGENTS.md](AGENTS.md), and platform artifacts (the macOS DMG)
are produced and verified only on a controlled macOS runner.

## License

[MIT](LICENSE) © 2026 SaraiNoQ. Bundled dependency licenses and copyright notices are listed in
[docs/THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md).
