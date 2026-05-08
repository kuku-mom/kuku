# 개발

> [English](development.md)

이 문서는 구현 중심 내용을 루트 README에서 분리해 둔 개발 참고 문서입니다. 모든 환경에서 그대로 따라야 하는 고정 절차라기보다, Kuku를 살펴보고 개발할 때 참고할 출발점으로 봐 주세요. 레포지토리는 빠르게 바뀌므로 세부가 다를 때는 작업 중인 코드에 가장 가까운 script, package manifest, `env.example`을 우선 확인하는 편이 좋습니다.

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

## 환경 참고

- pnpm
- Rust
- Go
- Docker / Docker Compose

## 참고용 명령

의존성은 보통 다음 명령으로 설치합니다.

```sh
pnpm install
```

워크스페이스 전체 체크는 다음 명령을 참고하세요.

```sh
pnpm check
pnpm test
pnpm build
```

protobuf 계약은 다음 명령으로 다시 생성할 수 있습니다.

```sh
pnpm contract:generate
```

데스크톱 개발의 일반적인 진입점은 다음과 같습니다.

```sh
pnpm --filter @kuku/desktop tauri:dev
```

웹 개발의 일반적인 진입점은 다음과 같습니다.

```sh
pnpm --filter @kuku/web dev
```

## 로컬 전체 스택 참고

web + API + database를 함께 띄워야 할 때는 아래 Docker 구성을 출발점으로 참고하세요.

```sh
cd infra/docker/local
cp env.example env
docker compose up -d --build
```

기본 로컬 주소는 다음과 같습니다.

```text
Web     http://localhost:8081
API     http://localhost:8080
Mailpit http://localhost:8025
```

## 셀프 호스팅 참고

Kuku 서버는 Go + Postgres 기반이며 Docker Compose 구성을 제공합니다. 아래 구성은 직접 배포 환경을 만들 때 참고할 출발점이며, 유일한 정답 토폴로지라는 의미는 아닙니다.

- `infra/docker/local`: 로컬 개발용 web + server + postgres + mailpit
- `infra/docker/preview`: 프리뷰 환경
- `infra/docker/prod`: Cloudflare Tunnel 뒤에서 실행하는 프로덕션 API 서버

프로덕션 구성은 웹 앱을 Cloudflare Pages에 배포하고, API는 `api.kuku.mom` 같은 호스트명 아래에서 Cloudflare Tunnel로 노출하는 방식을 기준으로 합니다.

운영 세부 설정은 `infra/docker/*` 아래의 README와 `env.example`에서 시작하세요.

## 릴리즈 메모

웹사이트와 updater 릴리즈 메타데이터는 `apps/web/src/config/prod_release.ts`에 있고, 데스크톱 번들 버전은 `apps/desktop/src-tauri/tauri.conf.json`에 있습니다.
