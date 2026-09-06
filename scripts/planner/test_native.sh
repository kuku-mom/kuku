#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'Planner EventKit tests require macOS; skipping.\n'
  exit 0
fi

planner_repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
planner_test_dir="$(mktemp -d)"
trap 'rm -rf "$planner_test_dir"' EXIT
xcrun clang++ -std=c++17 -fobjc-arc -fblocks -mmacosx-version-min=10.15 \
  "$planner_repo_root/apps/desktop/src-tauri/native/planner/test_macos_eventkit.mm" \
  -framework Foundation -framework AppKit -framework EventKit \
  -o "$planner_test_dir/planner-native-tests"
"$planner_test_dir/planner-native-tests"
