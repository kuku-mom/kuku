# Development

> [한국어](development_ko.md)

This document keeps implementation-oriented notes out of the main README. Treat it as a reference for exploring and developing Kuku, not as a rigid setup recipe. The repository changes quickly, so when details differ, prefer the scripts, package manifests, and `env.example` files closest to the code you are working on.

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

## Environment Reference

- pnpm
- Rust
- Go
- Docker / Docker Compose

## Useful Commands

Dependencies are usually installed with:

```sh
pnpm install
```

The broad workspace checks are:

```sh
pnpm check
pnpm test
pnpm build
```

The protobuf contracts can be regenerated with:

```sh
pnpm contract:generate
```

For desktop development, the usual entry point is:

```sh
pnpm --filter @kuku/desktop tauri:dev
```

For web development, the usual entry point is:

```sh
pnpm --filter @kuku/web dev
```

## Local Full Stack Reference

When you need the full web + API + database stack locally, use the Docker setup as a reference starting point:

```sh
cd infra/docker/local
cp env.example env
docker compose up -d --build
```

Default local endpoints are:

```text
Web     http://localhost:8081
API     http://localhost:8080
Mailpit http://localhost:8025
```

## Self-Hosting References

Kuku's server is built with Go + Postgres and ships with Docker Compose configurations. Use these as starting points for your own deployment rather than assuming they are the only supported topology.

- `infra/docker/local`: local development with web + server + postgres + mailpit
- `infra/docker/preview`: preview environment
- `infra/docker/prod`: production API server behind Cloudflare Tunnel

The production topology expects the web app to be deployed to Cloudflare Pages, with the API exposed through Cloudflare Tunnel under a hostname such as `api.kuku.mom`.

For operational details, start with the READMEs and `env.example` files under `infra/docker/*`.

## Release Notes

Release metadata for the website and updater lives in `apps/web/src/config/prod_release.ts`, while the desktop bundle version lives in `apps/desktop/src-tauri/tauri.conf.json`.
