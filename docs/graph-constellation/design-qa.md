# Quiet Constellation — 3D graph design QA

Visual redesign result: passed (before the trackpad follow-up)

Scope: apply the user's first generated direction to the existing live 3D graph. The subsequent user instruction overrides the mock's tinted backgrounds: use Kuku's default light/dark background tokens. This is a data-driven renderer, not a raster reconstruction of the mock's fictional graph.

## Sources and evidence

- Selected source: [reference](reference.png), 2103 × 748, two theme frames of approximately 1052 × 748.
- Final real-component overview: [light](final-light.png), [dark](final-dark.png).
- Final selected-document state: [light](selected-light.png), [dark](selected-dark.png).
- Additional states: [1500 nodes](dense.png), [340 × 440 compact canvas](compact.png).
- Production GraphTab / GraphCanvas3D rendered through the local synthetic-data fixture at `/tests/graph/index.html`; 220 notes, 5 folders. The backend is mocked; no vault content or native application packaging is part of this fixture.

The source and both implementation themes were opened in the same comparison input, for both overview and selected-document views. Initial comparisons used a 1052 × 748 viewport. Final independent-tab captures use the native 1280 × 720 viewport at screenshot density 1; evaluate relative hierarchy and spacing, not raw horizontal pixel offsets. The source's invented edge topology and camera are not available as data, so individual node positions are intentionally determined by real simulation and orbit controls. Light/dark implementation pairs retain the same camera and graph state.

## Findings resolved during iteration

1. P2 — unreadable labels and excessive text texture size in the first screen-size implementation. Keep SpriteText's canvas dimensions in ordinary text units, then scale the sprite into screen units. Final labels remain readable at overview and zoom, with no new texture resize warnings.
2. P2 — initial nodes clipped at canvas edges, and library fit left excessive whitespace. Seed stable 3D positions and fit actual document bounds in camera space with UI padding. Final overview fits all five groups; compact view also fits.
3. P2 — existing selection of a note outside the graph dimmed the entire graph. Validate focus against visible paths, including after folder filtering. Only actual graph focus dims neighbors.
4. P2 — selected label border and inactive-cluster fade were too strong. Reduce selected scale, soften label border, retain colored inactive links, and raise context opacity. Final selected-theme pair shows a restrained ring and readable surrounding clusters.
5. P2 — default library hover tooltip duplicated the sprite label. Disable the default tooltip and retain the bounded sprite label pool.

No remaining P0/P1/P2 findings for this scope.

## Visual checks

- Typography: existing configured editor font; bounded 12–13 px labels, selected hierarchy, collision suppression, no clipped label boxes in checked views.
- Layout: 52 px header, upper-right vertical controls, bottom folder legend, separate volumetric folder groups, subtle selection ring and thin links.
- Tokens: computed graph background exactly equals `--color-bg-primary`: light `rgb(250, 250, 250)` / `#fafafa`; dark `rgb(26, 26, 26)` / `#1a1a1a`. This user-requested difference from the reference is intentional.
- Assets: graph points/edges remain live Three.js data rendering; existing Kuku icon components and fonts are reused. No decorative raster assets are needed.
- Detail inspection: node/label selection was inspected at close zoom, in addition to overview comparisons; the close view motivated the label-offset and node-size caps.
- P3: cluster coordinates, visible density and some control-icon shapes differ from the generated image because the implementation uses live graph data and existing Kuku controls. Existing reset/follow controls are retained.

## Interaction and engineering checks

Passed: node click and document tab dispatch, camera orbit drag, zoom about current target, fit-all, theme change with stable camera, folder filtering, 3D settings and keyboard slider change, 2D/3D switching, empty-data removal, data reload, component unmount/remount, compact view, and 1500-node rendering.

Fresh isolated verification tabs reported no browser console errors or warnings. This is a render/interactivity smoke check, not an FPS benchmark or native Tauri end-to-end test.

- TypeScript application + test-fixture check: passed.
- Scoped oxlint: 0 errors, 0 warnings.
- Graph suite: 11 files, 37 tests passed.
- Vite production build: passed; bundle-size advisory remains.
- `git diff --check`: passed.

## Trackpad follow-up

Added pixel-scroll panning, pointer-centered pinch zoom, Shift-scroll orbit, native WebKit gesture handling and cancellation of automatic camera transitions on user input. Eight additional tests cover these controls (45 graph tests in total). Browser checks confirm scrolling moves the graph without changing zoom, and Fit restores the overview. Native trackpad pinch feel has not been verified on hardware.
