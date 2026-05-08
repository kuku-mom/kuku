#!/bin/bash
# Build only the production web bundle.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_DIR="$REPO_ROOT/apps/web"
WEB_RELEASE_SCRIPT="$WEB_DIR/scripts/update_prod_release_config.mjs"
OUTPUT_DIR="${1:-$REPO_ROOT/release-artifacts/prod/web}"

if [[ "$OUTPUT_DIR" != /* ]]; then
    OUTPUT_DIR="$REPO_ROOT/$OUTPUT_DIR"
fi

BLUE='\033[0;34m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[OK]${NC}   $*"; }
log_error() { echo -e "${RED}[ERR]${NC}  $*"; }

PROD_API_URL="$(cd "$WEB_DIR" && node "$WEB_RELEASE_SCRIPT" read apiBaseUrl)"
PROD_WEB_URL="$(cd "$WEB_DIR" && node "$WEB_RELEASE_SCRIPT" read webUrl)"

log_info "Cleaning web dist and output directory"
rm -rf "$WEB_DIR/dist" "$OUTPUT_DIR"
mkdir -p "$(dirname "$OUTPUT_DIR")"

log_info "Building production web bundle"
log_info "PUBLIC_KUKU_API_BASE_URL=${PROD_API_URL}"

(cd "$WEB_DIR" && PUBLIC_KUKU_API_BASE_URL="$PROD_API_URL" pnpm build)

if [[ ! -d "$WEB_DIR/dist" ]]; then
    log_error "Expected web dist at ${WEB_DIR}/dist"
    exit 1
fi

mv "$WEB_DIR/dist" "$OUTPUT_DIR"

log_success "Web bundle moved to ${OUTPUT_DIR}"
log_info "Deploy with: wrangler pages deploy ${OUTPUT_DIR} --project-name=<prod-pages-project>"
log_info "Verify after deploy: curl ${PROD_WEB_URL}/release.json | jq"
