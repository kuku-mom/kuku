# 🧪 Markdown Parsing Test Suite

> This document was translated from Korean to English by AI.

This document is a test file to verify that CommonMark standard syntax, GFM (GitHub Flavored Markdown) extensions, and custom blocks are correctly parsed and rendered in ProseMirror.

---

## 1. CommonMark Standard Tests (Basic Syntax)

Basic text formatting should be parsed correctly.
This is **bold text**, this is _italic text_, and this is **_bold and italic combined_**.
Inline code is displayed like `const a = 1;`.

### Lists

Unordered list with nesting test:

- Apple
- Banana
  - Unripe banana
  - Ripe banana
    - Baby banana
- Cherry

Ordered list:

1. First step
2. Second step
   1. Sub-step A
   2. Sub-step B

### Blockquotes

> This is a blockquote block.
> It can span multiple lines.
>
> > Nested blockquotes should also be handled correctly.

### Links & Images

- [Tauri Official Website](https://tauri.app)
- ![Alt text dummy image for testing](https://via.placeholder.com/150)
- ![Real image](https://picsum.photos/300/400)

---

## 2. GFM Extension Tests (GitHub Flavored Markdown)

From this point on, a GFM-specific parser plugin (e.g., additional `markdown-it` configuration) is required for proper node tree insertion.

### Strikethrough

This text should have a ~~strikethrough applied~~.

### Autolinks

URLs written without angle brackets should be recognized as links: https://github.com/wooorm/markdown-rs

### Task Lists

- [x] Install GFM plugin
- [ ] Test checkbox state toggling (state should change on click in ProseMirror)
- [ ] Apply CSS styling

### Tables

Verify that the table structure maps correctly to the editor's Table Node.

| Feature       | CommonMark | GFM |           Note |
| :------------ | :--------: | :-: | -------------: |
| Paragraph     |     ✅     | ✅  |   Left-aligned |
| Strikethrough |     ❌     | ✅  | Center-aligned |
| Table         |     ❌     | ✅  |  Right-aligned |

---

## 3. Code Blocks & Custom Format Tests (Fenced Code Blocks)

Standard syntax highlighting tests for various languages.

```rust
// Rust code parsing test
fn main() {
    println!("Hello, Tauri & ProseMirror!");
}
```

```javascript
// JavaScript code parsing test
import { EditorState } from 'prosemirror-state';
console.log('State initialized');
```

### 🚧 The Grand Custom Format (Custom NodeView Test)

This is a custom format block as designed. This block should not be rendered as a regular code block, but as a special `NodeView` (SolidJS component).

```custom-format
title: "Test Data"
type: chart
data: [10, 20, 30, 40, 50]
description: "This area should be rendered beautifully as a SolidJS component within ProseMirror, and after editing, it should be saved back as this raw text."
```

---

_End of Test Suite._
