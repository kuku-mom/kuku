/* eslint-disable typescript/no-misused-spread -- Ulpaso's reconciliation intentionally matches Unicode code points on both sides before rejoining them. */
import type { PMNodeJSON } from "~/lib/markdown";

interface MeetingTranscriptSegment {
  speaker?: number | null;
  text: string;
  start?: number | null;
  end?: number | null;
}

function reconcileMeetingTranscriptSegments(
  previousSegments: MeetingTranscriptSegment[],
  stableText: string,
  currentSpeaker?: number,
): MeetingTranscriptSegment[] {
  const nextText = stableText.trim().replace(/\s+/g, " ");
  if (!nextText) return [];

  const previous = previousSegments.filter((segment) => segment.text.trim());
  if (!previous.length) {
    return [{ speaker: currentSpeaker ?? null, text: nextText }];
  }

  const oldUnits: string[] = [];
  const oldSpeakers: (number | null)[] = [];
  previous.forEach((segment, index) => {
    if (index) {
      oldUnits.push(" ");
      oldSpeakers.push(previous[index - 1].speaker ?? null);
    }
    for (const unit of segment.text.trim()) {
      oldUnits.push(unit);
      oldSpeakers.push(segment.speaker ?? null);
    }
  });
  const newUnits = [...nextText];
  if (!oldUnits.length) {
    return [{ speaker: currentSpeaker ?? null, text: nextText }];
  }

  let prefix = 0;
  while (
    prefix < oldUnits.length &&
    prefix < newUnits.length &&
    oldUnits[prefix] === newUnits[prefix]
  )
    prefix += 1;

  let suffix = 0;
  while (
    suffix < oldUnits.length - prefix &&
    suffix < newUnits.length - prefix &&
    oldUnits[oldUnits.length - 1 - suffix] === newUnits[newUnits.length - 1 - suffix]
  )
    suffix += 1;

  const labels = Array.from<number | null>({ length: newUnits.length }).fill(null);
  for (let index = 0; index < prefix; index += 1) labels[index] = oldSpeakers[index];
  for (let offset = 0; offset < suffix; offset += 1) {
    labels[newUnits.length - 1 - offset] = oldSpeakers[oldSpeakers.length - 1 - offset];
  }

  const oldMiddleLength = oldUnits.length - prefix - suffix;
  const newMiddleLength = newUnits.length - prefix - suffix;
  for (let offset = 0; offset < newMiddleLength; offset += 1) {
    if (oldMiddleLength <= 0) {
      labels[prefix + offset] = currentSpeaker ?? oldSpeakers.at(-1) ?? null;
      continue;
    }
    const oldOffset = Math.min(
      oldMiddleLength - 1,
      Math.floor(((offset + 0.5) * oldMiddleLength) / newMiddleLength),
    );
    labels[prefix + offset] = oldSpeakers[prefix + oldOffset];
  }

  // A correction can move a speaker boundary into the middle of a word.
  // Keep each whitespace-delimited word intact by using its majority label.
  let wordStart = 0;
  while (wordStart < newUnits.length) {
    if (/\s/u.test(newUnits[wordStart])) {
      labels[wordStart] = labels[wordStart - 1] ?? labels[wordStart + 1] ?? currentSpeaker ?? null;
      wordStart += 1;
      continue;
    }
    let wordEnd = wordStart + 1;
    while (wordEnd < newUnits.length && !/\s/u.test(newUnits[wordEnd])) wordEnd += 1;
    const counts = new Map<number | null, number>();
    const order: (number | null)[] = [];
    for (let index = wordStart; index < wordEnd; index += 1) {
      const label = labels[index];
      if (!counts.has(label)) order.push(label);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const label = order.reduce((best, candidate) =>
      (counts.get(candidate) ?? 0) > (counts.get(best) ?? 0) ? candidate : best,
    );
    labels.fill(label, wordStart, wordEnd);
    wordStart = wordEnd;
  }

  const reconciled: MeetingTranscriptSegment[] = [];
  let runStart = 0;
  for (let index = 1; index <= newUnits.length; index += 1) {
    if (index < newUnits.length && labels[index] === labels[runStart]) continue;
    const text = newUnits.slice(runStart, index).join("").trim();
    if (text) {
      const speaker = labels[runStart];
      const last = reconciled.at(-1);
      if (last?.speaker === speaker) last.text = `${last.text} ${text}`;
      else reconciled.push({ speaker, text });
    }
    runStart = index;
  }
  return reconciled.length ? reconciled : [{ speaker: currentSpeaker ?? null, text: nextText }];
}

function compactSpeakerLabels(segments: MeetingTranscriptSegment[]) {
  const labels = new Map<number, number>();
  return segments
    .filter((segment) => segment.text.trim())
    .map((segment) => {
      if (segment.speaker == null) return { ...segment, speaker: null };
      if (!labels.has(segment.speaker)) labels.set(segment.speaker, labels.size + 1);
      return { ...segment, speaker: labels.get(segment.speaker) };
    });
}

function preserveSpeakerBoundaries(
  previousSegments: MeetingTranscriptSegment[],
  correctedSegments: MeetingTranscriptSegment[],
): MeetingTranscriptSegment[] {
  const previous = compactSpeakerLabels(previousSegments);
  const corrected = compactSpeakerLabels(correctedSegments);
  const previousSpeakers = new Set(
    previous.flatMap((segment) => (segment.speaker == null ? [] : [segment.speaker])),
  );
  const correctedSpeakers = new Set(
    corrected.flatMap((segment) => (segment.speaker == null ? [] : [segment.speaker])),
  );
  // Live Sortformer labels are provisional and can briefly occupy all four
  // slots even in a two-person recording. Once the bounded full-file pass
  // finds two or more speakers, trust it instead of restoring those noisy
  // live labels. Preserve live boundaries only for the narrow regression we
  // can defend: exactly two stable live speakers collapsed to zero or one.
  if (previousSpeakers.size !== 2 || correctedSpeakers.size >= 2) return corrected;

  const correctedText = corrected.map((segment) => segment.text.trim()).join(" ");
  if (!correctedText) return previous;
  return reconcileMeetingTranscriptSegments(
    previous,
    correctedText,
    corrected.at(-1)?.speaker ?? previous.at(-1)?.speaker ?? undefined,
  );
}

function createMeetingDocumentNodes(
  title: string,
  segments: MeetingTranscriptSegment[],
  speakerLabel = "Speaker",
): PMNodeJSON[] {
  const paragraphs = segments
    .filter((segment) => segment.text.trim())
    .flatMap((segment): PMNodeJSON[] => {
      const nodes: PMNodeJSON[] = [];
      if (segment.speaker) {
        nodes.push({
          type: "paragraph",
          content: [
            {
              type: "text",
              text: `${speakerLabel} ${segment.speaker}`,
              marks: [{ type: "bold" }],
            },
          ],
        });
      }
      nodes.push({
        type: "paragraph",
        content: [{ type: "text", text: segment.text.trim() }],
      });
      return nodes;
    });

  return [
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: title }],
    },
    ...(paragraphs.length ? paragraphs : [{ type: "paragraph" }]),
  ];
}

export {
  createMeetingDocumentNodes,
  preserveSpeakerBoundaries,
  reconcileMeetingTranscriptSegments,
};
export type { MeetingTranscriptSegment };
