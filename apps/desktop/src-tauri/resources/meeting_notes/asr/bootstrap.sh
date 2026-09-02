#!/bin/zsh
set -euo pipefail

runtime_dir="$1"
resource_dir="${0:A:h}"
tools_dir="${runtime_dir:h}/ASR Tools"
uv_version="0.12.1"
uv_archive="uv-aarch64-apple-darwin"
uv_sha256="77d2906988e8074fd43f2f329ec452ebbf9b0c257ba1c66451c71de70a6baf42"
uv_bin="$tools_dir/uv-$uv_version"

mkdir -p "$tools_dir"

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
"$uv_bin" python install 3.12.13
if [[ ! -x "$runtime_dir/bin/python3" ]]; then
  "$uv_bin" venv --python 3.12.13 --python-preference only-managed "$runtime_dir"
fi
"$uv_bin" pip install --python "$runtime_dir/bin/python3" --requirement "$resource_dir/requirements.lock"
/usr/bin/touch "$runtime_dir/.kuku-meeting-ready"
