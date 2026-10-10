#!/usr/bin/env bash
set -euo pipefail
if [[ "$(uname -s)" != Darwin ]]; then exit 0; fi
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
test_binary="$(mktemp -t kuku-meeting-native-test)"
trap 'rm -f "$test_binary"' EXIT
# Recent Apple SDKs emit a libc++ availability #warning for the app's
# existing macOS 10.15 target. Keep that diagnostic visible while treating
# compiler warnings in the capture code as errors.
xcrun clang++ -std=c++17 -fobjc-arc -fblocks -Wall -Wextra -Werror '-Wno-error=#warnings' -mmacosx-version-min=10.15 \
  "$repo_root/apps/desktop/src-tauri/native/meeting_notes/test_macos_audio_capture.mm" \
  -framework AppKit -framework AVFoundation -framework AudioToolbox \
  -framework CoreAudio -framework CoreMedia -framework Foundation \
  -weak_framework ScreenCaptureKit -o "$test_binary"
"$test_binary"
