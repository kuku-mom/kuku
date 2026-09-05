# Quiet Constellation

Selected direction: first generated image, `reference.png`. Follow-up requirement: inherit Kuku's default theme background through `--color-bg-primary`.

The production implementation lives in `apps/desktop/src/plugins/builtin/graph_view/graph_canvas_3d.tsx`, with shared 3D palette/layout helpers in `graph_constellation.ts`, scoped styling in `graph_constellation.css`, and the full-view toolbar/legend in `graph_tab.tsx`. The 2D palette and force settings are unchanged.

## Local visual fixture

From `apps/desktop`, start the existing Vite frontend (`node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173`). Then open:

- `/tests/graph/index.html?theme=light`
- `/tests/graph/index.html?theme=dark`
- `/tests/graph/index.html?theme=dark&nodes=1500`
- `/tests/graph/index.html?theme=light&compact=1`

The fixture imports the production components and supplies deterministic synthetic graph data and mocked native IPC. It is separate from the production application entry point. Bottom-right fixture actions exercise theme, empty/reload and mount/unmount states.

See `design-qa.md` for comparison evidence, resolved findings and validation scope. `final-light.png` and `final-dark.png` are the completed overview captures; `selected-light.png` and `selected-dark.png` show the completed selection treatment. Earlier `light.png` and `dark.png` preserve an intermediate comparison.

## Trackpad navigation

The full and compact 3D graphs use two-finger pixel scrolling to pan, pinch to zoom around the pointer, and Shift + scrolling to orbit. Click-drag also orbits; Alt/Option + wheel zooms for mice that emit pixel scrolling. Line/page-mode mouse wheels retain zoom. OS scroll momentum is preserved without adding synthetic inertia. Starting a gesture or pointer interaction cancels camera transitions and pending automatic fit.

`graph_trackpad_controls.ts` handles Chromium Ctrl-wheel and WebKit cumulative gesture scales, suppresses duplicate pinch events, and removes its listeners during cleanup. Eight interaction tests cover movement, zoom anchoring/limits, rotation, mouse fallback, native gesture sequences, disabled controls and disposal. The graph suite passes 45 tests. Browser preview verified pixel-scroll movement with unchanged zoom and Fit recovery; real Mac trackpad pinch feel still needs a hardware check.

Validation from `apps/desktop`:

```sh
node node_modules/vitest/vitest.mjs run src/plugins/builtin/graph_view
node node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
node node_modules/typescript/bin/tsc -p tests/graph/tsconfig.json --noEmit
```

The isolated main-based branch also passed scoped lint and a Vite production build (with the existing bundle-size advisory).
