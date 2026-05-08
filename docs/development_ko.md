# 개발

> [English](development.md)

이 문서는 구현 중심 내용을 루트 README에서 분리해 둔 개발 문서입니다. 레포지토리 구조, 로컬 개발 명령, 셀프 호스팅 진입점을 다룹니다.

## 레포지토리 구조

```text
apps/
  desktop/     Tauri + SolidJS macOS 앱
  web/         Astro 웹사이트, 인증, 대시보드, 다운로드, 변경 기록, 로드맵
  server/      Go + Postgres API 서버

crates/
  kuku-ai/       데스크톱 AI 런타임
  kuku-indexer/  Markdown 추출, 검색, 위키링크 인덱싱
  kuku-contract/ Rust RPC 계약 바인딩

packages/
  contract/      protobuf 기반 공유 계약

infra/docker/
  local/         로컬 전체 스택
  preview/       프리뷰 서버 스택
  prod/          프로덕션 서버 스택
```

## 필요 환경

- pnpm `10.33.0`
- Rust / Cargo
- Go
- Docker / Docker Compose
- 데스크톱 앱 개발용 macOS

## 자주 쓰는 명령

의존성 설치:

```sh
pnpm install
```

전체 체크:

```sh
pnpm check
pnpm test
pnpm build
```

protobuf 계약 생성:

```sh
pnpm contract:generate
```

데스크톱 앱 실행:

```sh
pnpm --filter @kuku/desktop tauri:dev
```

웹 앱 실행:

```sh
pnpm --filter @kuku/web dev
```

## 로컬 전체 스택

```sh
cd infra/docker/local
cp env.example env
docker compose up -d --build
```

기본 로컬 주소:

```text
Web     http://localhost:8081
API     http://localhost:8080
Mailpit http://localhost:8025
```

## 셀프 호스팅 진입점

Kuku 서버는 Go + Postgres 기반이며 Docker Compose 구성을 제공합니다.

- `infra/docker/local`: 로컬 개발용 web + server + postgres + mailpit
- `infra/docker/preview`: 프리뷰 환경
- `infra/docker/prod`: Cloudflare Tunnel 뒤에서 실행하는 프로덕션 API 서버

프로덕션 구성은 웹 앱을 Cloudflare Pages에 배포하고, API는 `api.kuku.mom` 같은 호스트명 아래에서 Cloudflare Tunnel로 노출하는 방식을 기준으로 합니다.

운영 세부 설정은 `infra/docker/*` 아래의 README와 `env.example`에서 시작하세요.

## 릴리즈 메모

웹사이트와 updater 릴리즈 메타데이터는 `apps/web/src/config/prod_release.ts`에 있고, 데스크톱 번들 버전은 `apps/desktop/src-tauri/tauri.conf.json`에 있습니다.
