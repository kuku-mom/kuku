# E2EE Sync Local Test Runbook

This runbook is for the current Phase3 local sync test gate. The local test path uses RustFS through the S3-compatible presigned transfer APIs before any real S3/R2 bucket is used.

## Current Scope

- Server metadata, CAS publish, quota, GC, local object storage, and S3-compatible presigned transfer paths are implemented.
- Desktop Rust push/pull/merge/checkpoint engines are covered by unit and integration-style tests.
- Desktop `sync_run_once` is wired to run pull, push, stale-head pull/merge/retry, passphrase unlock, and status updates from the UI command path.

## Local Test Stack

Start the full local test infrastructure:

```bash
cp infra/docker/local-test/env.example infra/docker/local-test/env
pnpm run local-test:up
```

For another computer on the same LAN, set these in `infra/docker/local-test/env` before running `local-test:up`:

```env
PUBLIC_HOST=<server-lan-ip>
RUSTFS_ENDPOINT_HOST=<server-lan-ip>
```

Endpoints:

- Web: `http://<host>:8081`
- API: `http://<host>:8080`
- Mailpit: `http://<host>:8025`
- RustFS console: `http://<host>:9001`
- RustFS S3 API: `http://<host>:9000`

## Local Engine Test

Start the normal server test dependencies:

```bash
cd apps/server
pnpm run deps:up
```

Run the local server and desktop engine checks:

```bash
GOCACHE=$PWD/../../.cache/go-build KUKU_TEST_DATABASE_URL='postgres://kuku:kuku@127.0.0.1:5555/kuku?sslmode=disable' go test ./internal/sync -count=1
cd ../..
pnpm exec moon run desktop:test-rust --force
```

This validates the LocalObjectStore service roundtrip, publish correctness, quota/GC behavior, and the Rust engine's push, pull, merge, conflict-copy, and checkpoint flows.

## RustFS Object Storage Test

Start Postgres, mailpit, and RustFS from the server test stack:

```bash
cd apps/server
pnpm run deps:up:rustfs
```

RustFS endpoints:

- S3 API: `http://127.0.0.1:9000`
- Console: `http://127.0.0.1:9001`
- Access key: `rustfsadmin`
- Secret key: `rustfsadmin`
- Test bucket: `kuku-sync-test`

Run the RustFS integration test:

```bash
pnpm run test:sync-rustfs
```

The test creates the bucket if needed, reserves a sync object, uploads ciphertext through the presigned PUT URL, completes the upload through the service, downloads through the presigned GET URL, and verifies object delete/HEAD behavior.

## Manual QA Checklist

- Local test stack starts with server, web, Postgres, Mailpit, and RustFS.
- Desktop login completes through local web and Mailpit OTP.
- Device A creates a workspace from the sync UI and publishes initial content.
- Device B joins the workspace from the sync UI and bootstraps content.
- Local engine tests pass with a clean test Postgres.
- RustFS object storage test passes.
- Stale head conflict tests pass.
- Quota exceeded tests pass.
- Object storage partial failure tests pass through mismatch and expired upload cases.
- Conflict copies use `{origin}.conflict-{yyyyMMdd-HHmmss}.md`, with numeric suffixes on collision.
- No server API, DB object key, log output, or object metadata contains plaintext vault paths, file names, file hashes, or markdown content.
- GC reports only opaque commit/object identifiers and does not delete reachable objects.

## Known Limitations

- Real AWS S3/R2 remains a separate provider decision after RustFS local testing passes.
- Passphrase recovery is covered by key envelope/crypto tests, but still needs a manual UI recovery pass before wider testing.
- Daily sync testing should stay hidden until the owner approves the known limitations and current failure states.

## Rollback and Disable

- Disable sync from the app by turning off sync in the sync settings.
- Disable server exposure with `SYNC_FEATURE_ENABLED=false`.
- For local dev/test only, stop dependencies with `cd apps/server && pnpm run deps:down`.
- For RustFS test data reset, use `cd apps/server && docker compose -f test/docker-compose.test.yml down -v`.
- For the full local test stack, stop with `pnpm run local-test:down` or reset with `pnpm run local-test:reset`.
