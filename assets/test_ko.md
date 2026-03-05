# 🧪 Markdown Parsing Test Suite

이 문서는 CommonMark 표준 문법과 GFM(GitHub Flavored Markdown) 확장 문법, 그리고 커스텀 블록이 ProseMirror에서 정상적으로 파싱되고 렌더링되는지 확인하기 위한 테스트 파일입니다.

---

## 1. CommonMark 표준 테스트 (기본 문법)

기본적인 텍스트 포맷팅이 정상적으로 파싱되어야 합니다.
이것은 **굵은 글씨(Bold)** 이고, 이것은 _기울임꼴(Italic)_ 이며, **_둘 다 적용된 글씨_** 입니다.
인라인 코드는 `const a = 1;` 처럼 표시됩니다.

### 리스트 (Lists)

순서가 없는 리스트와 중첩 테스트입니다:

- 사과
- 바나나
  - 덜 익은 바나나
  - 잘 익은 바나나
    - 몽키바나나
- 체리

순서가 있는 리스트입니다:

1. 첫 번째 단계
2. 두 번째 단계
   1. 하위 단계 A
   2. 하위 단계 B

### 인용문 (Blockquotes)

> 인용문 블록입니다.
> 여러 줄에 걸쳐 작성할 수 있습니다.
>
> > 중첩된 인용문도 정상적으로 처리되어야 합니다.

### 링크와 이미지 (Links & Images)

- [Tauri 공식 홈페이지](https://tauri.app)
- ![대체 텍스트 테스트용 더미 이미지](https://via.placeholder.com/150)
- ![진짜이미지](https://picsum.photos/300/400)

---

## 2. GFM 확장 문법 테스트 (GitHub Flavored Markdown)

여기서부터는 GFM 전용 파서 플러그인(예: `markdown-it`의 추가 설정)이 있어야 정상적으로 노드 트리에 꽂힙니다.

### 취소선 (Strikethrough)

이 텍스트는 ~~취소선이 그어져야~~ 합니다.

### 자동 링크 (Autolinks)

URL을 꺾쇠 없이 적어도 링크로 인식해야 합니다: https://github.com/wooorm/markdown-rs

### 작업 목록 (Task Lists)

- [x] GFM 플러그인 설치하기
- [ ] 체크박스 상태 변경 테스트하기 (ProseMirror에서 클릭 시 상태가 변해야 함)
- [ ] CSS 스타일링 적용하기

### 테이블 (Tables)

테이블 구조가 에디터의 Table Node로 정확히 매핑되는지 확인하세요.

| 기능   | CommonMark | GFM |      비고 |
| :----- | :--------: | :-: | --------: |
| 단락   |     ✅     | ✅  | 좌측 정렬 |
| 취소선 |     ❌     | ✅  | 중앙 정렬 |
| 테이블 |     ❌     | ✅  | 우측 정렬 |

---

## 3. 코드 블록 및 커스텀 포맷 테스트 (Fenced Code Blocks)

일반적인 언어별 문법 강조(Syntax Highlighting) 테스트입니다.

```rust
// Rust 코드 파싱 테스트
fn main() {
    println!("Hello, Tauri & ProseMirror!");
}
```

```javascript
// JavaScript 코드 파싱 테스트
import { EditorState } from 'prosemirror-state';
console.log('State initialized');
```

### 🚧 대망의 커스텀 포맷 (Custom NodeView Test)

질문자님이 기획하신 커스텀 포맷 블록입니다. 이 블록은 일반 코드 블록이 아니라, 특별한 `NodeView`(SolidJS 컴포넌트)로 렌더링되어야 합니다.

```custom-format
title: "테스트 데이터"
type: chart
data: [10, 20, 30, 40, 50]
description: "이 영역은 ProseMirror 내에서 SolidJS 컴포넌트로 예쁘게 렌더링되어야 하며, 편집 후 다시 이 raw text로 저장되어야 합니다."
```

---

_End of Test Suite._
