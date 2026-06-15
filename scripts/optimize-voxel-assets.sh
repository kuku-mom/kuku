#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
input_dir="${INPUT_DIR:-$repo_root/assets/voxel/original}"
output_dir="${OUTPUT_DIR:-$repo_root/apps/desktop/src/plugins/builtin/voxel_graph/world/assets}"
texture_compress="${TEXTURE_COMPRESS:-webp}"
texture_size="${TEXTURE_SIZE:-1024}"
compress="${COMPRESS:-quantize}"
simplify="${SIMPLIFY:-false}"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required" >&2
  exit 1
fi

if [[ ! -d "$input_dir" ]]; then
  echo "input directory does not exist: $input_dir" >&2
  exit 1
fi

mkdir -p "$output_dir"

shopt -s nullglob
inputs=("$input_dir"/*.glb)
if (( ${#inputs[@]} == 0 )); then
  echo "no .glb files found in $input_dir" >&2
  exit 1
fi

printf "%-18s %10s %10s %8s\n" "file" "original" "optimized" "saved"
for input in "${inputs[@]}"; do
  name="$(basename "$input")"
  output="$output_dir/$name"
  pnpm dlx @gltf-transform/cli optimize "$input" "$output" \
    --texture-compress "$texture_compress" \
    --texture-size "$texture_size" \
    --compress "$compress" \
    --simplify "$simplify" >/tmp/kuku-gltf-optimize.log 2>&1
  pnpm dlx @gltf-transform/cli validate "$output" >/tmp/kuku-gltf-validate.log 2>&1

  raw_bytes="$(wc -c < "$input" | tr -d ' ')"
  opt_bytes="$(wc -c < "$output" | tr -d ' ')"
  awk -v name="$name" -v raw="$raw_bytes" -v opt="$opt_bytes" 'BEGIN {
    printf "%-18s %9.1fM %9.1fM %7.1f%%\n", name, raw / 1048576, opt / 1048576, (1 - opt / raw) * 100
  }'
done

printf "\noptimized output: %s\n" "$output_dir"
printf "total optimized: "
du -ch "$output_dir"/*.glb | tail -n 1
