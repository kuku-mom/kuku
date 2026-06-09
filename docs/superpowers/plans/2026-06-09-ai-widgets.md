# AI Widgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build AI-generated chat widgets and persistent widget projects in Kuku, excluding CLI agent integration.

**Architecture:** Add a frontend `ai-widgets` builtin plugin that registers proxy AI tools through the existing `core-tool-registry`. Store projects in the plugin filesystem sandbox and render successful widget artifact tool outputs in AI chat through a sandboxed iframe.

**Tech Stack:** SolidJS, Vitest, Tauri v2 `invoke`, existing Kuku plugin system, existing AI proxy tool bridge.

---

### Task 1: Widget Artifact Core

**Files:**
- Create: `apps/desktop/src/plugins/builtin/ai_widgets/types.ts`
- Create: `apps/desktop/src/plugins/builtin/ai_widgets/artifact.ts`
- Test: `apps/desktop/src/plugins/builtin/ai_widgets/artifact.test.ts`

- [ ] **Step 1: Write failing artifact tests**

Run: `pnpm --filter @kuku/desktop exec vitest run src/plugins/builtin/ai_widgets/artifact.test.ts`

Expected: fail because files do not exist.

- [ ] **Step 2: Implement artifact parsing and serialization**

Create types for widget files, projects, and artifact envelopes. Implement explicit JSON parsing that accepts only `kind: "kuku.widget-artifact"` and `version: 1`.

- [ ] **Step 3: Run artifact tests until green**

Run: `pnpm --filter @kuku/desktop exec vitest run src/plugins/builtin/ai_widgets/artifact.test.ts`

Expected: pass.

### Task 2: Widget Project Store

**Files:**
- Create: `apps/desktop/src/plugins/builtin/ai_widgets/project_store.ts`
- Test: `apps/desktop/src/plugins/builtin/ai_widgets/project_store.test.ts`

- [ ] **Step 1: Write failing store tests**

Test path validation, manifest writes, file writes, project listing, and project reads with an injected fake filesystem.

- [ ] **Step 2: Implement store**

Use injected `readText`, `writeText`, and `readDir` methods, with a Tauri-backed default using `plugin_fs_read_text`, `plugin_fs_write_text`, and `plugin_fs_read_dir`.

- [ ] **Step 3: Run store tests until green**

Run: `pnpm --filter @kuku/desktop exec vitest run src/plugins/builtin/ai_widgets/project_store.test.ts`

Expected: pass.

### Task 3: AI Tool Registration

**Files:**
- Create: `apps/desktop/src/plugins/builtin/ai_widgets/ai_tools.ts`
- Create: `apps/desktop/src/plugins/builtin/ai_widgets/index.ts`
- Modify: `apps/desktop/src/plugins/bootstrap.ts`
- Test: `apps/desktop/src/plugins/builtin/ai_widgets/ai_tools.test.ts`

- [ ] **Step 1: Write failing AI tool tests**

Verify `create_widget`, `list_widgets`, and `read_widget` register with the proxy registry and return artifact JSON.

- [ ] **Step 2: Implement AI tools and plugin activation**

Normalize model arguments, persist widget projects, return artifact envelopes, and add the plugin to builtin bootstrap.

- [ ] **Step 3: Run AI tool tests until green**

Run: `pnpm --filter @kuku/desktop exec vitest run src/plugins/builtin/ai_widgets/ai_tools.test.ts`

Expected: pass.

### Task 4: Sandboxed Chat Renderer

**Files:**
- Create: `apps/desktop/src/plugins/builtin/ai_widgets/widget_preview.tsx`
- Create: `apps/desktop/src/plugins/builtin/ai_widgets/iframe_document.ts`
- Modify: `apps/desktop/src/plugins/builtin/ai_chat/components/tool_progress.tsx`
- Test: `apps/desktop/src/plugins/builtin/ai_widgets/iframe_document.test.ts`

- [ ] **Step 1: Write failing iframe document tests**

Verify CSP, sandbox policy constants, HTML/SVG wrapping, and no same-origin allowance.

- [ ] **Step 2: Implement iframe document and preview component**

Render successful widget artifact tool outputs beneath the compact tool progress line.

- [ ] **Step 3: Run renderer tests until green**

Run: `pnpm --filter @kuku/desktop exec vitest run src/plugins/builtin/ai_widgets/iframe_document.test.ts`

Expected: pass.

### Task 5: Build And Runtime Verification

**Files:**
- No new files expected.

- [ ] **Step 1: Run focused frontend tests**

Run all `ai_widgets` tests.

- [ ] **Step 2: Run desktop build**

Run: `pnpm --filter @kuku/desktop build`

Expected: TypeScript and Vite build pass.

- [ ] **Step 3: Run Rust check**

Run: `cargo check -p kuku-app`

Expected: pass.

- [ ] **Step 4: Run Tauri app and inspect UI**

Run the Tauri dev app, then use computer/browser tooling to confirm Kuku opens and the AI tool list includes widget tools.
