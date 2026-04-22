# Kuku

English | [한국어](README_ko.md)

![License](https://img.shields.io/github/license/kuku-mom/kuku)
![Last commit](https://img.shields.io/github/last-commit/kuku-mom/kuku)
![Issues](https://img.shields.io/github/issues/kuku-mom/kuku)
![Stars](https://img.shields.io/github/stars/kuku-mom/kuku)
![Platform](https://img.shields.io/badge/platform-macOS-111827)
![Runtime](https://img.shields.io/badge/runtime-Tauri%20v2-0f172a)
![UI](https://img.shields.io/badge/ui-SolidJS-0b1220)

Local-first markdown desktop workspace for focused thinking.

Kuku combines plain-file markdown editing, wikilinks/backlinks, graph navigation, and in-app AI workflows with approval-based file mutations.

![Kuku social card](docs/assets/readme-social-card.png)

## Screens

<table>
  <tr>
    <th>Workspace Shell</th>
    <th>Provider Setup</th>
  </tr>
  <tr>
    <td><img src="docs/screenshots/kuku-screen-1.png" alt="Kuku workspace shell" /></td>
    <td><img src="docs/screenshots/kuku-screen-2-settings.png" alt="Kuku provider setup" /></td>
  </tr>
  <tr>
    <td>Real app workspace with vault tree, center editor, and right utility rail.</td>
    <td>Desktop-side provider and key setup flow for AI integration.</td>
  </tr>
  <tr>
    <th>Search Surface</th>
    <th>Search With Query</th>
  </tr>
  <tr>
    <td><img src="docs/screenshots/kuku-screen-3-search.png" alt="Kuku search surface" /></td>
    <td><img src="docs/screenshots/kuku-screen-4-search-query.png" alt="Kuku search with query" /></td>
  </tr>
  <tr>
    <td>Advanced search tab for vault-wide lookup inside the app.</td>
    <td>Query state for fast note discovery and keyboard-first navigation.</td>
  </tr>
</table>

## Why Kuku

- Local-first markdown workflow on your own files
- Wikilinks, backlinks, and graph-first navigation
- AI-assisted editing with explicit approval for file changes
- Native desktop runtime via Tauri (not Electron)

## Quick start

```bash
pnpm install
pnpm --filter @kuku/desktop tauri:dev
```

## Repository layout

```text
apps/
  desktop/     Tauri desktop app (SolidJS frontend + Rust backend)
  web/         Astro site (landing/auth/dashboard)
  server/      Go API server (Connect RPC)
crates/
  kuku-ai/       AI integration
  kuku-contract/ RPC contract (Rust)
  kuku-indexer/  file indexing
packages/
  contract/    shared contract (gen/go + gen/ts)
infra/docker/
  local/       local stack (web + server + postgres + mailpit)
  preview/     staging
  prod/        production
```

## Contributing

Issues and PRs are welcome. For large changes, open an issue first.

## License

[MIT](LICENSE) © kuku-mom
