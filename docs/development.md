# Development

> [한국어](development_ko.md)

This document keeps the implementation-oriented notes out of the main README. It covers the repository layout, local development commands, and self-hosting entry points.

## Repository Layout

```text
apps/
  desktop/     Tauri + SolidJS macOS app
  web/         Astro website, auth, dashboard, downloads, changelog, roadmap
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

## Prerequisites

- pnpm `10.33.0`
- Rust / Cargo
- Go
- Docker / Docker Compose
- macOS for desktop app development

## Common Commands

Install dependencies:

```sh
pnpm install
```

Run the full checks:

```sh
pnpm check
pnpm test
pnpm build
```

Generate protobuf contracts:

```sh
pnpm contract:generate
```

Run the desktop app:

```sh
pnpm --filter @kuku/desktop tauri:dev
```

Run the web app:

```sh
pnpm --filter @kuku/web dev
```

## Local Full Stack

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

## Self-Hosting Entry Points

Kuku's server is built with Go + Postgres and ships with Docker Compose configurations.

- `infra/docker/local`: local development with web + server + postgres + mailpit
- `infra/docker/preview`: preview environment
- `infra/docker/prod`: production API server behind Cloudflare Tunnel

The production topology expects the web app to be deployed to Cloudflare Pages, with the API exposed through Cloudflare Tunnel under a hostname such as `api.kuku.mom`.

For operational details, start with the READMEs and `env.example` files under `infra/docker/*`.

## Release Notes

Release metadata for the website and updater lives in `apps/web/src/config/prod_release.ts`, while the desktop bundle version lives in `apps/desktop/src-tauri/tauri.conf.json`.
