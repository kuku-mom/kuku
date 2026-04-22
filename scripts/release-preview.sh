#!/bin/bash
# =============================================================================
# Kuku preview build & release-bundle script
#
# Builds the preview-variant desktop app (KukuPreview) and the preview web
# bundle, writes a Tauri updater manifest that points the preview channel
# at the new build, and collects everything into release-artifacts/preview/
# for hand-off to GitHub Releases + Cloudflare Pages.
#
# Preview is deliberately separate from prod:
#   • bundle identifier `mom.kuku.app.preview` (separate keychain + ~/.kuku.preview)
#   • deep-link scheme `kuku-preview` / `com.kuku.app.preview`
#   • updater endpoint `https://preview.kuku.mom/release.json`
#   • API target `https://preview-api.kuku.mom`
#
# Apple notarization is NOT required for preview — Tauri's minisign flow
# is what the updater checks, and since the updater replaces the .app
# in-place (no quarantine bit), Gatekeeper won't re-scan. Ad-hoc signed
# (or even unsigned) is fine for updater-channel testing.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DESKTOP_DIR="$REPO_ROOT/apps/desktop"
WEB_DIR="$REPO_ROOT/apps/web"
PREVIEW_CONF="$DESKTOP_DIR/src-tauri/tauri.preview.conf.json"
# release.json is generated into the built dist after each build — it's
# per-build data (signature, pub_date) that shouldn't live in the
# source tree. apps/web/dist is gitignored; nothing to commit.
RELEASE_JSON_DEST="$WEB_DIR/dist/release.json"
RELEASE_DIR="$REPO_ROOT/release-artifacts/preview"
BUNDLE_DIR="$REPO_ROOT/target/release/bundle"

# Override with env vars when topology changes — e.g. a new preview pages
# project or a different GH repo for preview uploads.
GH_REPO="${KUKU_GITHUB_REPO:-kuku-mom/kuku}"
PREVIEW_API_URL="${KUKU_PREVIEW_API_URL:-https://preview-api.kuku.mom}"
PREVIEW_WEB_URL="${KUKU_PREVIEW_WEB_URL:-https://preview.kuku.mom}"

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
    if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
        log_error "TAURI_SIGNING_PRIVATE_KEY is required (preview minisign private key)."
        log_error "Export it (or source ~/.kuku-preview-env) before running this script."
        exit 1
    fi
    if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
        log_warn "APPLE_SIGNING_IDENTITY not set — preview DMG will be unsigned."
        log_warn "OK for updater-channel testing; Gatekeeper will warn on first open."
    fi
    log_success "Environment OK"
}

get_current_version() {
    python3 - "$PREVIEW_CONF" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
print(data.get("version", "0.0.0-preview.0"))
PY
}

update_preview_version() {
    local version="$1"
    python3 - "$PREVIEW_CONF" "$version" <<'PY'
import json, sys
path, version = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
data["version"] = version
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
    log_success "tauri.preview.conf.json version → ${version}"
}

build_desktop() {
    log_info "Building KukuPreview bundle (Cargo release profile + devtools + preview env)…"
    rm -rf "$BUNDLE_DIR"
    (cd "$REPO_ROOT" && pnpm exec moon run desktop:tauri-build-preview)
    log_success "KukuPreview bundle ready"
}

write_release_manifest() {
    local version="$1" pub_date="$2" signature="$3"
    local tar_name="KukuPreview.app.tar.gz"
    local tar_url="https://github.com/${GH_REPO}/releases/download/preview-${version}/${tar_name}"

    # Guard against a mis-ordered caller: we write into dist/ because the
    # manifest is per-build data, so the web build must have run first.
    if [[ ! -d "$WEB_DIR/dist" ]]; then
        log_error "Web dist is missing at $WEB_DIR/dist — build web before writing release.json"
        exit 1
    fi

    cat > "$RELEASE_JSON_DEST" <<EOF
{
  "version": "${version}",
  "notes": "Preview build ${version}",
  "pub_date": "${pub_date}",
  "platforms": {
    "darwin-aarch64": {
      "signature": "${signature}",
      "url": "${tar_url}"
    }
  }
}
EOF
    log_success "release.json → ${RELEASE_JSON_DEST}"
    log_info "   Will be served at ${PREVIEW_WEB_URL}/release.json"
}

build_web() {
    log_info "Building web (PUBLIC_KUKU_API_BASE_URL=${PREVIEW_API_URL})…"
    (cd "$WEB_DIR" && PUBLIC_KUKU_API_BASE_URL="$PREVIEW_API_URL" pnpm build)
    log_success "Web build complete"
}

collect_artifacts() {
    local version="$1"
    local out_dir="$RELEASE_DIR/$version"
    local dmg_src="$BUNDLE_DIR/dmg/KukuPreview_${version}_aarch64.dmg"
    local tar_src="$BUNDLE_DIR/macos/KukuPreview.app.tar.gz"
    local sig_src="${tar_src}.sig"

    rm -rf "$out_dir"
    mkdir -p "$out_dir/github" "$out_dir/web"

    # DMG is optional — if the build skipped it (e.g. `--bundles app`) this
    # guard lets the tar.gz-only flow still collect successfully.
    if [[ -f "$dmg_src" ]]; then
        cp "$dmg_src" "$out_dir/github/"
    else
        log_warn "DMG not found at $dmg_src — skipping (tar.gz is sufficient for updater)"
    fi
    cp "$tar_src" "$out_dir/github/"
    cp "$sig_src" "$out_dir/github/"

    cp -R "$WEB_DIR/dist/." "$out_dir/web/"

    cat > "$out_dir/README.md" <<EOF
# KukuPreview ${version}

Generated: $(date "+%Y-%m-%d %H:%M:%S")

## Layout

\`\`\`
${version}/
├── github/                                     → GitHub preview release
│   ├── KukuPreview_${version}_aarch64.dmg      (optional; for manual install)
│   ├── KukuPreview.app.tar.gz                  (served by the updater)
│   └── KukuPreview.app.tar.gz.sig              (minisign signature)
└── web/                                        → Cloudflare Pages (preview project)
\`\`\`

## Next steps

### 1. Upload desktop artifacts to GitHub

\`\`\`sh
gh release create preview-${version} \\
  --repo ${GH_REPO} \\
  --prerelease \\
  --title "KukuPreview ${version}" \\
  --notes "Preview build" \\
  github/KukuPreview_${version}_aarch64.dmg \\
  github/KukuPreview.app.tar.gz \\
  github/KukuPreview.app.tar.gz.sig
\`\`\`

The \`url\` in \`web/release.json\` points at this tag, so the tag name
must match \`preview-${version}\`.

### 2. Deploy web bundle to Cloudflare Pages

\`\`\`sh
wrangler pages deploy ${WEB_DIR}/dist --project-name=<preview-pages-project>
\`\`\`

(The identical bundle is also at \`web/\` in this folder if you prefer to
deploy from outside the repo.)

### 3. Verify

\`\`\`sh
curl ${PREVIEW_WEB_URL}/release.json | jq
\`\`\`

Install a previous KukuPreview build and confirm it detects the new
version and downloads \`${tar_src##*/}\`.
EOF

    log_success "Artifacts → $out_dir"
}

main() {
    echo
    echo "═══════════════════════════════════════════════════"
    echo "       KukuPreview build & bundle"
    echo "═══════════════════════════════════════════════════"
    echo

    check_env

    local current_version
    current_version=$(get_current_version)

    local new_version="${1:-}"
    if [[ -z "$new_version" ]]; then
        echo -e "Current preview version: ${YELLOW}${current_version}${NC}"
        read -r -p "New preview version (e.g. 0.1.0-preview.1): " new_version
    fi
    [[ -z "$new_version" ]] && { log_error "Version required"; exit 1; }

    echo
    echo -e "  ${current_version} → ${GREEN}${new_version}${NC}"
    echo
    read -r -p "Continue? (y/N): " confirm
    [[ "$confirm" != "y" && "$confirm" != "Y" ]] && { log_info "Aborted."; exit 0; }
    echo

    update_preview_version "$new_version"
    build_desktop

    local sig_path="${BUNDLE_DIR}/macos/KukuPreview.app.tar.gz.sig"
    [[ ! -f "$sig_path" ]] && { log_error "Signature missing at $sig_path"; exit 1; }
    local signature
    signature=$(cat "$sig_path")
    local pub_date
    pub_date=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

    # Web build first so dist/ exists for the manifest. Manifest comes
    # last because its signature + pub_date can only be computed after
    # the Tauri bundle is sealed.
    build_web
    write_release_manifest "$new_version" "$pub_date" "$signature"
    collect_artifacts "$new_version"

    echo
    echo "═══════════════════════════════════════════════════"
    echo -e "  ${GREEN}✓ Preview ${new_version} ready${NC}"
    echo "═══════════════════════════════════════════════════"
    echo
    echo "Commit the version bump:"
    echo "  git add apps/desktop/src-tauri/tauri.preview.conf.json"
    echo "  git commit -m \"chore(preview): bump to ${new_version}\""
    echo
    echo "release.json is regenerated per build inside dist/ (not committed)."
    echo "See $RELEASE_DIR/$new_version/README.md for upload + deploy steps."
    echo

    open "$RELEASE_DIR/$new_version" 2>/dev/null || true
}

main "$@"
