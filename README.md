<div align="center">
  <h1 align="center">
    <a href="https://kuku.mom">
      <img src="assets/logo/logo.svg" alt="Kuku logo" width="42" align="center">
    </a>
    Kuku
  </h1>

  <p align="center">
    <strong>A local-first Markdown knowledge workspace for macOS.</strong><br>
    Plain files, personal wiki, Second Brain workflows, AI diffs, and encrypted sync.
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
    <a href="https://kuku.mom/roadmap"><strong>Roadmap</strong></a> ·
    <a href="docs/development.md"><strong>Development</strong></a> ·
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

## What Is Kuku?

Kuku is an open-source Markdown app for people who want their notes to stay portable, private, and useful to AI. It edits ordinary `.md` files in a local vault, then layers search, graph navigation, AI assistance, Second Brain workflows, and encrypted sync on top.

The project is not just a desktop app. This repository includes the macOS client, web app, Go server, protobuf contracts, Rust AI/indexing crates, and Docker infrastructure needed to inspect or self-host the system.

## Why It Exists

- **Your files should stay yours**: notes remain plain Markdown, not hidden platform data.
- **AI should be reviewable**: AI can read, search, and propose changes, but edits flow through approval and diffs.
- **Knowledge should improve explicitly**: decision documents turn AI proposals into traceable memory and wiki updates.
- **Infrastructure should be inspectable**: server, sync, contracts, and deployment code live in the open.
- **Cloud should be optional**: use Kuku locally, sign in for managed convenience, or self-host the stack yourself.

## Highlights

- **Local Markdown vault**: open a folder and keep writing in files that work with git, vim, Obsidian, and other Markdown tools.
- **Personal wiki**: connect notes with `[[wikilinks]]`, backlinks, search, and 2D / 3D graph navigation.
- **Second Brain workflows**: manage memory, wiki pages, proposals, and decisions as Markdown inside your vault.
- **Self-improving AI context**: accept, reject, or revise decision documents so future AI conversations inherit better context.
- **AI-native editing**: use Agent / Ask / Inline modes, attach files or selected text, and review proposed edits before applying.
- **Encrypted sync foundation**: sync workspaces, devices, key envelopes, signed commits, and encrypted objects without exposing plaintext notes to the server.

## Install

The official build is currently available for macOS.

- **Download from the website**: visit [kuku.mom](https://www.kuku.mom/) and download the latest macOS build.
- **GitHub Releases**: download the DMG directly from [GitHub Releases](https://github.com/kuku-mom/kuku/releases).
- **Homebrew**: planned. A Homebrew tap/formula is on the roadmap for a one-command macOS install.

Platform status:

- macOS: supported
- Windows: coming soon
- Linux: coming soon

## Open Source

Kuku is built as a full-stack open-source project, not a thin client around a closed service. If you want to explore how it works, start with:

- [DeepWiki codebase guide](https://deepwiki.com/kuku-mom/kuku)
- [Development and self-hosting notes](docs/development.md)
- [Public roadmap](https://www.kuku.mom/roadmap/)

## Contributing

Bug reports, feature ideas, documentation improvements, and pull requests are welcome. For larger changes, please open an issue first so we can align on direction.

Kuku's core principle is simple: your files belong to you, and the tool should not take that control away.

## License

[MIT](LICENSE) © kuku-mom
