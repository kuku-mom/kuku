# Voxel assets

`original/` contains the unoptimized source GLBs and PNG references for the
Agent World voxel models.

The desktop runtime downloads optimized GLBs from:

```text
apps/desktop/src/plugins/builtin/voxel_graph/world/assets
```

Regenerate optimized runtime GLBs with:

```bash
scripts/optimize-voxel-assets.sh
```

The default preset is WebP textures at 1024px, quantized geometry, and no mesh
simplification. Override settings with environment variables:

```bash
TEXTURE_SIZE=2048 scripts/optimize-voxel-assets.sh
TEXTURE_COMPRESS=auto COMPRESS=quantize scripts/optimize-voxel-assets.sh
```
