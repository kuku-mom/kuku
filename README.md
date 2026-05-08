<div align="center">
  <a href="https://kuku.mom">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logo/logo.svg">
      <source media="(prefers-color-scheme: light)" srcset="assets/logo/logo.svg">
      <img src="assets/logo/logo.svg" alt="Kuku" width="96">
    </picture>
  </a>

  <h1 align="center">Kuku</h1>

  <p align="center">
    <strong>A local-first Markdown knowledge workspace for macOS.</strong><br>
    Plain files, personal wiki, second brain workflows, AI diffs, and encrypted sync.
  </p>

  <p align="center">
    <a href="https://github.com/kuku-mom/kuku/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-f97316.svg" alt="License MIT"></a>
    <a href="https://github.com/kuku-mom/kuku/releases"><img src="https://img.shields.io/github/v/release/kuku-mom/kuku?label=release&color=2563eb" alt="Latest release"></a>
    <a href="https://github.com/kuku-mom/kuku"><img src="https://img.shields.io/github/stars/kuku-mom/kuku?style=flat&color=facc15" alt="GitHub stars"></a>
    <a href="https://deepwiki.com/kuku-mom/kuku"><img src="https://img.shields.io/badge/DeepWiki-Codebase-181818" alt="DeepWiki"></a>
    <img src="https://img.shields.io/badge/platform-macOS-111827?logo=apple&logoColor=white" alt="macOS">
    <img src="https://img.shields.io/badge/built%20with-Tauri%20%2B%20SolidJS-24c8db" alt="Built with Tauri and SolidJS">
  </p>

  <p align="center">
    <a href="https://kuku.mom"><strong>Website</strong></a> ·
    <a href="https://github.com/kuku-mom/kuku/releases"><strong>Download</strong></a> ·
    <a href="https://deepwiki.com/kuku-mom/kuku"><strong>DeepWiki</strong></a> ·
    <a href="https://kuku.mom/changelog"><strong>Changelog</strong></a> ·
    <a href="https://kuku.mom/roadmap"><strong>Roadmap</strong></a> ·
    <a href="README_ko.md"><strong>한국어</strong></a>
  </p>

  <p align="center">
    <a href="https://kuku.mom">
      <img src="assets/readme/kuku-desktop-vault.png" alt="Kuku desktop app screenshot" width="960">
    </a>
  </p>
</div>

<p align="center">
  ⭐ <em>If Kuku feels useful or interesting, a GitHub star helps the project reach more people.</em>
</p>

## Kuku

Kuku is an open-source Markdown app for writing, linking, searching, syncing, and organizing your knowledge with AI on top of ordinary `.md` files. Your notes stay in a folder on your computer; account features, AI, and sync are optional layers you can choose to add.

## Why Kuku?

Notion is convenient, but your data lives inside a platform. Obsidian is powerful, but it is Electron-based, and the experience of having AI carefully edit real files is still limited.

Kuku is built around a different set of tradeoffs.

- **Plain Markdown**: Every note is an ordinary `.md` file.
- **Local-first**: The app works locally first; cloud features are optional.
- **Native macOS**: A lightweight desktop app built with Tauri + SolidJS.
- **AI-native editing**: AI can search your vault, read files, and propose reviewable changes.
- **Self-improving knowledge**: Decision documents turn AI proposals into durable memory and wiki updates.
- **No lock-in**: Use it alongside vim, git, Obsidian, or any other Markdown tool.

The longer-term direction is complete user control: transparent code, inspectable infrastructure, and the freedom to use Kuku with our hosted service, your own server, or services you already trust.

## What works today

Kuku is currently focused on the macOS desktop app and the self-hostable server stack behind account, AI, and sync features.

### Local Markdown workspace

- Open a local vault folder and edit ordinary `.md` files directly.
- Use a SolidJS + ProseMirror editor with autosave, formatting commands, themes, typography, and keyboard shortcuts.
- Keep your files portable across git, vim, Obsidian, and other Markdown tools.

### Links, search, and graph

- Build a personal wiki with `[[wikilinks]]`, backlinks, and graph navigation.
- Index Markdown content, wikilink targets, and graph data through the Rust indexer.
- Use quick search, advanced search, backlink-aware graph view, 2D / 3D graph modes, clusters, orphan-note discovery, and vault stats.

### Second Brain and decision documents

- Use the Second Brain panel to manage knowledge memory, wiki pages, proposals, and decisions inside your vault.
- Let AI propose durable memory or wiki updates, then review them as Markdown decision documents before applying.
- Accept, reject, or revise proposed knowledge changes so the system improves from explicit decisions instead of hidden automation.
- Search committed memories and wiki pages, then bring that context back into future AI conversations.
- Keep every decision, proposal, and applied memory traceable as plain Markdown.

### AI tools for your vault

- Use Agent / Ask / Inline modes from the right panel.
- Attach files or selected text as context.
- Ask AI to search notes, summarize, proofread, translate, improve writing, suggest links, propose edits, and update Second Brain knowledge.
- Review AI edits through approval and diff flows before applying them.
- Connect through Kuku Remote after signing in, or configure a Gemini API key locally.

### Encrypted sync foundation

- Configure encrypted sync per vault with workspace, device, and passphrase settings.
- Register devices, store encrypted key envelopes, publish signed commits, transfer encrypted objects, and keep server-visible metadata opaque.
- Preserve conflict copies as normal Markdown files so the vault stays inspectable.
- Run the sync server locally or deploy it with the provided Docker infrastructure.

### Web and server

- Astro web app for the public site, auth pages, dashboard, downloads, changelog, and roadmap.
- Go + Postgres API server with OAuth, email OTP, AI endpoints, sync APIs, migrations, and production-ready Docker images.
- Local, preview, and production Docker Compose stacks, including Cloudflare Tunnel-based production exposure.

## Apps

This repository is a monorepo for the full Kuku product.

```text
apps/
  desktop/     Tauri + SolidJS macOS app
  web/         Astro website, auth, and dashboard
  server/      Go + Postgres API server

crates/
  kuku-ai/       Desktop AI runtime
  kuku-indexer/  Markdown extraction, search, and wikilink indexing
  kuku-contract/ Rust RPC contract bindings

packages/
  contract/      Shared protobuf contract

infra/docker/
  local/         Local full-stack environment
  preview/       Preview server stack
  prod/          Production server stack
```

## Install

The current production app version in this repository is `0.4.0`. The official build is currently available for macOS.

- **Download from the website**: visit [kuku.mom](https://www.kuku.mom/) and download the latest macOS build.
- **GitHub Releases**: download the DMG directly from [GitHub Releases](https://github.com/kuku-mom/kuku/releases).
- **Homebrew**: planned. A Homebrew tap/formula is on the roadmap for a one-command macOS install.

Platform status:

- macOS: supported
- Windows: coming soon
- Linux: coming soon

## Development

```sh
pnpm install
```

Run the full checks:

```sh
pnpm check
pnpm test
pnpm build
```

Run the desktop app:

```sh
pnpm --filter @kuku/desktop tauri:dev
```

Run the web app:

```sh
pnpm --filter @kuku/web dev
```

Run the local full stack:

```sh
cd infra/docker/local
cp env.example env
docker compose up -d --build
```

Default local endpoints:

```text
Web     http://localhost:8081
API     http://localhost:8080
Mailpit http://localhost:8025
```

## Self-hosting

The Kuku server is built with Go + Postgres and ships with Docker Compose configurations.

- `infra/docker/local`: local development with web + server + postgres + mailpit
- `infra/docker/preview`: preview environment
- `infra/docker/prod`: production API server behind Cloudflare Tunnel

The production topology expects the web app to be deployed to Cloudflare Pages, with the API exposed through Cloudflare Tunnel under a hostname such as `api.kuku.mom`.

For operational details, see the READMEs and `env.example` files under `infra/docker/*`.

## Choose your path

Kuku is designed so you are not forced into a single cloud model.

- **Self-host everything**: Run the server code on your own hardware, NAS, home server, or VPS.
- **Bring your own services**: Connect infrastructure you already trust, such as S3-compatible storage or local AI runtimes as they become available.
- **Buy convenience**: Use the managed kuku.mom service for hosted infrastructure, updates, and backups.

The promise is portability: start with the managed service if it is convenient, move to self-hosting later, and keep your data exportable.

## Roadmap

Kuku is under active development. The public roadmap tracks the path from the current local-first editor toward a complete, inspectable knowledge platform.

- [x] **Zero to First** — Shipped. Chose Tauri v2 over Electron and shipped the first local editor foundation with Markdown editing, bidirectional `[[wikilinks]]`, backlinks, and graph view.
- [x] **Product Hunt Launch** — Shipped. Released Gemini-powered AI Agent, local speech-to-text with Whisper.cpp, inline diff previews, and full-text search; community feedback clarified the need for user-controlled data and infrastructure.
- [x] **The Rebuild** — Shipped. Rebuilt the editor on SolidJS + pure ProseMirror for better performance, fewer wrapper constraints, and a cleaner base for plugins.
- [ ] **1.0 Release** — In progress. Open source everything in one repo: client, server, infra, self-hosting guides, Docker configs, Homebrew distribution, MeetingNote with local Whisper, and GitHub Sync.
- [ ] **Enhanced Search & Graph** — Post-1.0 planned. Add local embeddings through runtimes such as Ollama or ONNX Runtime, hybrid keyword + semantic search, semantic graph relationships, and contextual note recommendations.
- [ ] **Sync & Mobile** — Post-1.0 planned. Build zero-knowledge sync through kuku.mom, self-hosted servers, or your own storage; add native iOS and Android apps, conflict resolution, and offline-first background sync.
- [ ] **Extension Ecosystem** — Post-1.0 planned. Introduce a public plugin SDK, plugin marketplace, real-time collaboration extensions, web clipper, and secure local APIs for AI memory sharing.

Read the full roadmap: [Kuku Roadmap](https://www.kuku.mom/roadmap/) and [The Journey Toward Complete Freedom](https://www.kuku.mom/blog/kuku-roadmap-2026/).

## Values

These principles guide the project:

- **Local-first**: Your files are yours. Plain `.md`, always accessible, never locked in.
- **Privacy by default**: No forced account for the core editor, no unauthorized data collection, and no telemetry without explicit opt-in.
- **Transparent ecosystem**: The product, server, contracts, and deployment code are meant to be inspectable and self-hostable.
- **Freedom of choice**: Use our cloud, self-host, or bring your own services. Kuku should give you control, not take it away.

## Contributing

Bug reports, feature ideas, documentation improvements, and pull requests are welcome.

For larger changes, please open an issue first so we can align on direction. Kuku's core principle is simple: your files belong to you, and the tool should not take that control away.

## License

[MIT](LICENSE) © kuku-mom
