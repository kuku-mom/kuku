# Development

> [한국어](development_ko.md)

This document keeps implementation-oriented notes out of the main README. Treat it as a reference for exploring and developing Kuku, not as a rigid setup recipe. The repository changes quickly, so when details differ, prefer the scripts, package manifests, and `env.example` files closest to the code you are working on.

## Repository Layout

```text
apps/
  desktop/     Tauri + SolidJS macOS/Windows app
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

Windows bundles should be built on Windows with Rust, Go, and Visual Studio Build Tools installed.
The Visual Studio installer needs the "Desktop development with C++" workload so `link.exe` is available to Rust's MSVC toolchain.
To audit a local Windows machine before building, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-windows-build-prereqs.ps1
```

From an Administrator PowerShell, the same script can install the supported prerequisites via `winget`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-windows-build-prereqs.ps1 -Install
```

```sh
pnpm --filter @kuku/desktop tauri:build:windows
```

That build merges `apps/desktop/src-tauri/tauri.windows.conf.json` with the base Tauri config and emits NSIS/MSI installers.
MSI bundling must run on Windows and requires the Windows VBSCRIPT optional feature; `windows-latest` provides the right CI host, but local Windows machines may need that feature enabled.
For a release hand-off on Windows, use:

```powershell
.\scripts\release-windows.ps1
```

If local PowerShell script execution is disabled, run the same release script with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release-windows.ps1
```

The script runs the desktop frontend build, `cargo check --locked -p kuku-app --all-targets`, the Windows Tauri build, verifies that both `.exe` and `.msi` installers exist, and then collects them under `release-artifacts/windows/<version>/github`.
Pull requests that touch the desktop app, Rust crates, or shared contracts also run `.github/workflows/windows-desktop.yml`, which executes the same release script and uploads the collected NSIS/MSI artifacts.

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
