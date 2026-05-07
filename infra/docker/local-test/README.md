# Local Test Docker Stack

This stack runs the local sync test infrastructure in one compose project:

- Go server
- Astro web app for login/desktop auth
- Postgres
- Mailpit
- RustFS S3-compatible object storage

Unlike `infra/docker/local`, this stack is meant for desktop sync testing and
uses the presigned S3-compatible path by default.

## Start

```bash
cd infra/docker/local-test
cp env.example env
cd ../../..
pnpm run local-test:up
```

For another computer on the same LAN, set these two values in `env` before
building:

```env
PUBLIC_HOST=192.168.0.42
RUSTFS_ENDPOINT_HOST=192.168.0.42
```

Use the server Mac's actual LAN IP:

```bash
ipconfig getifaddr en0
```

After changing `PUBLIC_HOST`, rebuild `web` because the API URL is baked into
the static bundle:

```bash
pnpm run local-test:up
```

## Endpoints

For the default same-machine setup:

- Web: `http://localhost:8081`
- API: `http://localhost:8080`
- Mailpit: `http://localhost:8025`
- RustFS S3 API: `http://localhost:9000`
- RustFS console: `http://localhost:9001`
- RustFS login: `rustfsadmin` / `rustfsadmin`
- Postgres from host: `postgres://kuku:dev@localhost:5555/kuku?sslmode=disable`

For LAN testing, replace `localhost` with `PUBLIC_HOST`.

## Desktop Build Against This Stack

Same-machine:

```bash
cd apps/desktop
KUKU_API_URL=http://localhost:8080 \
VITE_KUKU_API_URL=http://localhost:8080 \
VITE_KUKU_WEB_URL=http://localhost:8081 \
pnpm tauri:dev
```

LAN build:

```bash
cd apps/desktop
KUKU_API_URL=http://192.168.0.42:8080 \
VITE_KUKU_API_URL=http://192.168.0.42:8080 \
VITE_KUKU_WEB_URL=http://192.168.0.42:8081 \
pnpm tauri build --config src-tauri/tauri.development.conf.json --debug --features devtools
```

## Manual Sync Flow

1. Open the desktop app and sign in.
2. Read email OTPs in Mailpit.
3. Open or create a vault on device A.
4. In Sync settings, leave Workspace ID empty, enter a passphrase, and enable sync.
5. Create a Markdown file and press Sync Now.
6. Copy the Workspace ID shown in Sync settings.
7. On device B, open another vault, enter that Workspace ID and the same passphrase, then enable sync.
8. Press Sync Now on device B and verify the file appears.
9. Edit different files on both devices and verify convergence.
10. Edit the same line on both devices and verify a `.conflict-yyyymmdd-HHmmss.md` copy appears without losing local content.

## Logs and Reset

`rustfs-init` is a one-shot bucket initializer. Normal status is
`Exited (0)` after it prints `Bucket created successfully`.

```bash
pnpm run local-test:logs -- server
pnpm run local-test:logs -- web
pnpm run local-test:logs -- rustfs
pnpm run local-test:logs -- rustfs-init
```

Stop without deleting data:

```bash
pnpm run local-test:down
```

Reset all local test data:

```bash
pnpm run local-test:reset
```
