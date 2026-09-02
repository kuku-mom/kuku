#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
bundle="${1:-$repo_root/target/debug/bundle/macos/KukuDev.app}"
identity="${KUKU_SIGNING_IDENTITY:-}"
if [[ -z "$identity" ]]; then
  identity="$(security find-identity -v -p codesigning \
    | sed -n 's/.*"\(Apple Development:.*\)"/\1/p' \
    | head -n 1)"
fi
if [[ -z "$identity" ]]; then
  echo "No Apple Development signing identity is available." >&2
  exit 1
fi

codesign --force --deep --timestamp=none --options runtime \
  --entitlements "$repo_root/apps/desktop/src-tauri/entitlements.plist" \
  --sign "$identity" "$bundle"
codesign --verify --deep --strict --verbose=2 "$bundle"
echo "Signed $bundle with $identity"
