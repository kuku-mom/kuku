# Local Docker Stack

Full kuku stack running against a containerized Postgres, on distinct host
ports so the browser treats web and API as separate origins and real CORS
flows get exercised end-to-end.

## Layout

```
http://localhost:8081  →  web  (astro static, nginx)
http://localhost:8080  →  server  (Go, Connect RPC)
127.0.0.1:5432         →  postgres  (dev password, loopback only)
```

All three bind to `127.0.0.1` only — nothing is reachable from the LAN.

## First-time setup

```bash
cd infra/docker/local
cp env.example env
# Edit `env` if you need OAuth / SMTP / Gemini — defaults work for
# anonymous browsing + health checks.

docker compose up -d --build
```

Build takes 2–5 min the first time; the BuildKit mount caches (go mod
+ go-build for server, pnpm store for web) mean rebuilds are seconds.

## Verify

```bash
# Server health (also what the container HEALTHCHECK hits)
curl http://localhost:8080/health        # → OK

# Connect RPC reachable
curl -X POST http://localhost:8080/kuku.auth.v1.AuthService/Profile \
  -H 'content-type: application/json'    # → 401 (expected — unauthenticated)

# Web reachable
open http://localhost:8081
```

CORS smoke: open DevTools on `localhost:8081`, trigger any API call
(e.g. the dashboard's profile fetch) and check the request lands with
`Origin: http://localhost:8081` and the server echoes
`Access-Control-Allow-Origin: http://localhost:8081`. Misconfiguration
shows up as an opaque CORS error in the console.

## Common tasks

```bash
# Tail logs
docker compose logs -f server
docker compose logs -f web

# Rebuild a single service after source changes
docker compose up -d --build server

# Reset the database (wipes committed dev data)
docker compose down -v
docker compose up -d

# psql into the running postgres
psql postgres://kuku:dev@localhost:5432/kuku

# Apply migrations manually (normally AUTO_MIGRATION=true handles it)
docker compose exec server /app/server migrate
```

## Relation to other tiers

- **Preview** (`../preview/`): same Dockerfiles, swaps postgres for a
  managed DB and adds a `cloudflared` container that exposes
  `preview.kuku.mom` / `preview-api.kuku.mom` through the tunnel.
- **Prod** (`../prod/`): ported legacy — HAProxy + blue-green, managed
  Postgres, CF Tunnel. Web goes to CF Pages, not this compose.

## Gotchas

- **`AUTO_MIGRATION=true`** applies every migration on boot against a
  fresh volume. Turn it off once you want to work with a long-lived
  local DB.
- **OAuth callbacks** require registered apps with the exact redirect
  URLs in `env`. Without them, the Sign-In buttons render but the
  round-trip fails at Google/GitHub.
- **Gemini** endpoints return `failed_precondition: remote ai is not
  configured` until `GEMINI_API_KEY` is set; the rest of the app is
  unaffected. The model is pinned in server code, not configured through
  `env`.
