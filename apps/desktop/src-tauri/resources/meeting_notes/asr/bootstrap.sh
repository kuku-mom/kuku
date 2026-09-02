#!/bin/zsh
set -euo pipefail

runtime_dir="$1"
resource_dir="${0:A:h}"
tools_dir="${runtime_dir:h}/ASR Tools"
uv_version="0.12.1"
uv_archive="uv-aarch64-apple-darwin"
uv_sha256="77d2906988e8074fd43f2f329ec452ebbf9b0c257ba1c66451c71de70a6baf42"
uv_bin="$tools_dir/uv-$uv_version"
runtime_manifest="$resource_dir/runtime_manifest.txt"
python_version="$(/usr/bin/awk -F= '/^python=/{print $2}' "$runtime_manifest")"
ready_marker="$runtime_dir/.kuku-meeting-ready"

if [[ -z "$python_version" ]]; then
  print -u2 "runtime manifest is missing the Python version."
  exit 1
fi

mkdir -p "$tools_dir"
/bin/rm -f "$ready_marker"

if [[ ! -x "$uv_bin" ]]; then
  archive_path="$tools_dir/$uv_archive.tar.gz"
  /usr/bin/curl --fail --location --silent --show-error \
    "https://github.com/astral-sh/uv/releases/download/$uv_version/$uv_archive.tar.gz" \
    --output "$archive_path"
  actual_sha256="$(/usr/bin/shasum -a 256 "$archive_path" | /usr/bin/awk '{print $1}')"
  if [[ "$actual_sha256" != "$uv_sha256" ]]; then
    /bin/rm -f "$archive_path"
    print -u2 "uv archive checksum verification failed."
    exit 1
  fi
  unpack_dir="$(/usr/bin/mktemp -d "$tools_dir/uv-unpack.XXXXXX")"
  /usr/bin/tar -xzf "$archive_path" -C "$unpack_dir"
  /bin/cp "$unpack_dir/$uv_archive/uv" "$uv_bin"
  /bin/chmod 755 "$uv_bin"
  /bin/rm -rf "$unpack_dir"
fi

export UV_PYTHON_INSTALL_DIR="$tools_dir/python"
export UV_CACHE_DIR="$tools_dir/cache"
"$uv_bin" python install "$python_version"
if [[ ! -x "$runtime_dir/bin/python3" ]]; then
  "$uv_bin" venv --python "$python_version" --python-preference only-managed "$runtime_dir"
fi
"$uv_bin" pip install --reinstall --python "$runtime_dir/bin/python3" --requirement "$resource_dir/requirements.lock"
marker_tmp="$ready_marker.tmp.$$"
/bin/cp "$runtime_manifest" "$marker_tmp"
/bin/mv -f "$marker_tmp" "$ready_marker"
