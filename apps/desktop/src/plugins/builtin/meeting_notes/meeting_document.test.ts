import { beforeAll, describe, expect, it } from "vitest";

import { editorCoreMarkdown } from "~/plugins/builtin/core_editor/markdown_handlers";
import {
  buildMarkdownService,
  contributeMarkdown,
  getMarkdownService,
} from "~/plugins/markdown_service";

import {
  createMeetingDocumentNodes,
  preserveSpeakerBoundaries,
  reconcileMeetingTranscriptSegments,
} from "./meeting_document";

beforeAll(() => {
  contributeMarkdown("meeting-document-test", editorCoreMarkdown);
  buildMarkdownService();
});

describe("meeting document markdown", () => {
  it("preserves speaker boundaries when the accuracy pass corrects stable text", () => {
    const corrected = reconcileMeetingTranscriptSegments(
      [
        { speaker: 1, text: "안녕하세요 오늘 회의를 시작합니다" },
        { speaker: 2, text: "두 번째 화자가 답합니다" },
      ],
      "안녕하세요. 오늘 회의를 시작합니다. 두 번째 화자가 답변합니다.",
      2,
    );

    expect(corrected.map((segment) => segment.speaker)).toEqual([1, 2]);
    expect(corrected.map((segment) => segment.text).join(" ")).toBe(
      "안녕하세요. 오늘 회의를 시작합니다. 두 번째 화자가 답변합니다.",
    );
  });

  it("does not collapse reliable live speaker turns when final diarization regresses", () => {
    const protectedSegments = preserveSpeakerBoundaries(
      [
        { speaker: 1, text: "첫 화자가 회의를 시작합니다" },
        { speaker: 2, text: "둘째 화자가 대답합니다" },
        { speaker: 1, text: "첫 화자가 마무리합니다" },
      ],
      [
        {
          speaker: 1,
          text: "첫 화자가 회의를 시작합니다. 둘째 화자가 대답합니다. 첫 화자가 마무리합니다.",
        },
      ],
    );

    expect(protectedSegments.map((segment) => segment.speaker)).toEqual([1, 2, 1]);
    expect(protectedSegments.map((segment) => segment.text).join(" ")).toBe(
      "첫 화자가 회의를 시작합니다. 둘째 화자가 대답합니다. 첫 화자가 마무리합니다.",
    );
  });

  it("trusts final two-speaker cleanup over four provisional live labels", () => {
    const cleaned = preserveSpeakerBoundaries(
      [
        { speaker: 1, text: "첫 발언" },
        { speaker: 2, text: "두 번째 임시 라벨" },
        { speaker: 3, text: "상대방 발언" },
        { speaker: 4, text: "네 번째 임시 라벨" },
      ],
      [
        { speaker: 1, text: "첫 발언 두 번째 임시 라벨" },
        { speaker: 2, text: "상대방 발언 네 번째 임시 라벨" },
      ],
    );

    expect(cleaned.map((segment) => segment.speaker)).toEqual([1, 2]);
  });

  it("compacts sparse final speaker labels in first-appearance order", () => {
    const cleaned = preserveSpeakerBoundaries(
      [{ speaker: 1, text: "실시간 문장" }],
      [
        { speaker: 1, text: "첫 화자" },
        { speaker: 3, text: "둘째 화자" },
        { speaker: 1, text: "첫 화자 마무리" },
      ],
    );

    expect(cleaned.map((segment) => segment.speaker)).toEqual([1, 2, 1]);
  });

  it("serializes final speaker turns as editable standard markdown", () => {
    const content = createMeetingDocumentNodes("미팅 노트 · 2026-08-04 14:30", [
      { speaker: 1, text: "첫 번째 발화 내용" },
      { speaker: 2, text: "두 번째 발화 내용" },
    ]);
    const markdown = getMarkdownService()?.stringify({ type: "doc", content });

    expect(markdown).toBe(
      [
        "## 미팅 노트 · 2026-08-04 14:30",
        "",
        "**Speaker 1**",
        "",
        "첫 번째 발화 내용",
        "",
        "**Speaker 2**",
        "",
        "두 번째 발화 내용",
        "",
      ].join("\n"),
    );
  });

  it("keeps an empty editable paragraph while capture is preparing", () => {
    expect(createMeetingDocumentNodes("미팅 노트", [])).toEqual([
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "미팅 노트" }],
      },
      { type: "paragraph" },
    ]);
  });
});
