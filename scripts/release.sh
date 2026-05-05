#!/bin/bash
# =============================================================================
# Kuku prod release build & bundle script
#
# Mirrors release-preview.sh but for the production channel:
#   • bundle identifier `mom.kuku.app` (keychain + ~/.kuku)
#   • deep-link scheme `kuku` / `com.kuku.app`
#   • updater endpoint `https://kuku.mom/release.json`
#   • API target `https://api.kuku.mom`
#
# Unlike preview, prod DMGs are Apple notarized (Gatekeeper on fresh installs).
# The in-place updater still verifies the minisign signature, so notarization
# only matters for the first-run DMG download.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DESKTOP_DIR="$REPO_ROOT/apps/desktop"
WEB_DIR="$REPO_ROOT/apps/web"
TAURI_CONF="$DESKTOP_DIR/src-tauri/tauri.conf.json"
WEB_RELEASE_SCRIPT="$WEB_DIR/scripts/update_prod_release_config.mjs"
RELEASE_DIR="$REPO_ROOT/release-artifacts/prod"
BUNDLE_DIR="$REPO_ROOT/target/release/bundle"

GH_REPO="$(cd "$WEB_DIR" && node "$WEB_RELEASE_SCRIPT" read githubRepo)"
PROD_API_URL="$(cd "$WEB_DIR" && node "$WEB_RELEASE_SCRIPT" read apiBaseUrl)"
PROD_WEB_URL="$(cd "$WEB_DIR" && node "$WEB_RELEASE_SCRIPT" read webUrl)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[OK]${NC}   $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error()   { echo -e "${RED}[ERR]${NC}  $*"; }

check_env() {
    local missing=()
    [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]            && missing+=("APPLE_SIGNING_IDENTITY")
    [[ -z "${APPLE_ID:-}" ]]                          && missing+=("APPLE_ID")
    [[ -z "${APPLE_PASSWORD:-}" ]]                    && missing+=("APPLE_PASSWORD")
    [[ -z "${APPLE_TEAM_ID:-}" ]]                     && missing+=("APPLE_TEAM_ID")
    [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]         && missing+=("TAURI_SIGNING_PRIVATE_KEY")
    [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]] && missing+=("TAURI_SIGNING_PRIVATE_KEY_PASSWORD")

    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Missing env vars:"
        for var in "${missing[@]}"; do echo "  - $var"; done
        echo ""
        echo "Tip: source ~/.kuku-release-env"
        exit 1
    fi
    log_success "Environment OK"
}

get_current_version() {
    python3 - "$TAURI_CONF" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
print(data.get("version", "0.0.0"))
PY
}

update_tauri_version() {
    local version="$1"
    python3 - "$TAURI_CONF" "$version" <<'PY'
import json, sys
path, version = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
data["version"] = version
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
    log_success "tauri.conf.json version → ${version}"
}

build_desktop() {
    log_info "Building Kuku bundle (Cargo release profile, takes ~5 min)…"
    rm -rf "$BUNDLE_DIR"
    (cd "$REPO_ROOT" && pnpm exec moon run desktop:tauri-build-prod)
    log_success "Kuku bundle ready"
}

update_web_release_config() {
    local version="$1" pub_date="$2" signature="$3"

    (cd "$WEB_DIR" && node "$WEB_RELEASE_SCRIPT" write "$version" "$pub_date" "$signature")
    log_success "prod_release.ts → ${version}"
}

build_web() {
    log_info "Building web (PUBLIC_KUKU_API_BASE_URL=${PROD_API_URL})…"
    (cd "$WEB_DIR" && PUBLIC_KUKU_API_BASE_URL="$PROD_API_URL" pnpm build)
    log_success "Web build complete"
}

notarize_dmg() {
    local dmg_path="$1"

    log_info "Notarizing DMG (takes 1–5 min)…"
    xcrun notarytool submit "$dmg_path" \
        --apple-id "$APPLE_ID" \
        --password "$APPLE_PASSWORD" \
        --team-id "$APPLE_TEAM_ID" \
        --wait

    log_info "Stapling notarization ticket…"
    xcrun stapler staple "$dmg_path"

    log_success "DMG notarized and stapled"
}

collect_artifacts() {
    local version="$1"
    local out_dir="$RELEASE_DIR/$version"
    local dmg_src="$BUNDLE_DIR/dmg/Kuku_${version}_aarch64.dmg"
    local tar_src="$BUNDLE_DIR/macos/Kuku.app.tar.gz"
    local sig_src="${tar_src}.sig"

    rm -rf "$out_dir"
    mkdir -p "$out_dir/github" "$out_dir/web"

    if [[ -f "$dmg_src" ]]; then
        cp "$dmg_src" "$out_dir/github/"
    else
        log_warn "DMG not found at $dmg_src — skipping (tar.gz is sufficient for updater)"
    fi
    cp "$tar_src" "$out_dir/github/"
    cp "$sig_src" "$out_dir/github/"

    cp -R "$WEB_DIR/dist/." "$out_dir/web/"

    cat > "$out_dir/README.md" <<EOF
# Kuku ${version}

Generated: $(date "+%Y-%m-%d %H:%M:%S")

## Layout

\`\`\`
${version}/
├── github/                              → GitHub release
│   ├── Kuku_${version}_aarch64.dmg      (notarized, for manual install)
│   ├── Kuku.app.tar.gz                  (served by the updater)
│   └── Kuku.app.tar.gz.sig              (minisign signature)
└── web/                                 → Cloudflare Pages (prod project)
\`\`\`

## Next steps

### 1. Upload desktop artifacts to GitHub

\`\`\`sh
gh release create ${version} \\
  --repo ${GH_REPO} \\
  --title "Kuku ${version}" \\
  --notes "Kuku ${version}" \\
  github/Kuku_${version}_aarch64.dmg \\
  github/Kuku.app.tar.gz \\
  github/Kuku.app.tar.gz.sig
\`\`\`

The \`url\` in \`web/release.json\` points at this tag, so the tag name
must match \`${version}\`.

### 2. Homebrew (kuku-tap)

\`\`\`sh
shasum -a 256 github/Kuku_${version}_aarch64.dmg
# update Formula/kuku.rb: version + sha256
\`\`\`

### 3. Deploy web bundle to Cloudflare Pages

\`\`\`sh
wrangler pages deploy ${WEB_DIR}/dist --project-name=<prod-pages-project>
\`\`\`

### 4. Verify

\`\`\`sh
curl ${PROD_WEB_URL}/release.json | jq
\`\`\`

Install a previous Kuku build and confirm it detects the new version
and downloads \`${tar_src##*/}\`.
EOF

    log_success "Artifacts → $out_dir"
}

main() {
    echo
    echo "═══════════════════════════════════════════════════"
    echo "       Kuku release build & bundle"
    echo "═══════════════════════════════════════════════════"
    echo

    check_env

    local current_version
    current_version=$(get_current_version)

    local new_version="${1:-}"
    if [[ -z "$new_version" ]]; then
        echo -e "Current version: ${YELLOW}${current_version}${NC}"
        read -r -p "New version (e.g. 0.1.0): " new_version
    fi
    [[ -z "$new_version" ]] && { log_error "Version required"; exit 1; }

    echo
    echo -e "  ${current_version} → ${GREEN}${new_version}${NC}"
    echo
    read -r -p "Continue? (y/N): " confirm
    [[ "$confirm" != "y" && "$confirm" != "Y" ]] && { log_info "Aborted."; exit 0; }
    echo

    update_tauri_version "$new_version"
    build_desktop

    local sig_path="${BUNDLE_DIR}/macos/Kuku.app.tar.gz.sig"
    [[ ! -f "$sig_path" ]] && { log_error "Signature missing at $sig_path"; exit 1; }
    local signature
    signature=$(cat "$sig_path")
    local pub_date
    pub_date=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

    update_web_release_config "$new_version" "$pub_date" "$signature"
    build_web
    collect_artifacts "$new_version"

    local dmg_path="$RELEASE_DIR/$new_version/github/Kuku_${new_version}_aarch64.dmg"
    if [[ -f "$dmg_path" ]]; then
        notarize_dmg "$dmg_path"
    else
        log_warn "DMG missing at $dmg_path — skipping notarization"
    fi

    echo
    echo "═══════════════════════════════════════════════════"
    echo -e "  ${GREEN}✓ Kuku ${new_version} ready${NC}"
    echo "═══════════════════════════════════════════════════"
    echo
    echo "Commit the version bump:"
    echo "  git add apps/desktop/src-tauri/tauri.conf.json apps/web/src/config/prod_release.ts"
    echo "  git commit -m \"release: ${new_version}\""
    echo
    echo "release.json is generated by apps/web/src/pages/release.json.ts during web build."
    echo "See $RELEASE_DIR/$new_version/README.md for upload + deploy steps."
    echo

    open "$RELEASE_DIR/$new_version" 2>/dev/null || true
}

main "$@"
