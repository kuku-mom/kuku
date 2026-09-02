#!/usr/bin/env python3
"""Persistent local Qwen3-ASR + Sortformer worker for Kuku.

stdin protocol: one-byte kind + little-endian u32 payload length + payload.
  1: float32 little-endian mono 16 kHz PCM
  2: finish and emit a final transcript
  3: cancel
stdout protocol: one compact JSON object per line.
"""

from __future__ import annotations

import argparse
import math
import os
import re
import time
import unicodedata
import wave
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from asr_artifacts import (
    ASR_REPO,
    DIAR_REPO,
    MODEL_REVISIONS,
    DownloadReporter,
    prepare_model,
    verify_model,
)
from asr_protocol import emit, read_frame

# Qwen3-ASR may echo free-form system context into short/noisy turn output.
# Keep the main decode unbiased and use the targeted Korean retry below only
# when auto language detection leaves the expected Korean/English set.
MEETING_CONTEXT = ""
ROLLING_REFINE_SECONDS = 20.0
REFINE_BUFFER_SECONDS = 24.0
REFINE_MIN_SECONDS = 16.0
REFINE_MAX_SECONDS = 22.0
REFINE_OVERLAP_SECONDS = 0.35
# Sortformer's non-streaming generate path attempted one 14.15 GB Metal buffer
# for a 28-minute podcast. Keep full-file diarization bounded and reuse the
# live streaming turns plus canonical 20-second transcript blocks above this.
FULL_FILE_DIARIZATION_LIMIT_SECONDS = 5.0 * 60.0
# Validated against 2-, 3-, and 4-speaker VoxConverse reference clips. 0.65
# erased quieter speakers in the 3-speaker sample; 0.40 preserved all expected
# speakers while keeping false-positive speech below 1.3% across the fixtures.
DIARIZATION_THRESHOLD = 0.40
# Speaker re-transcription can legitimately change punctuation and a few
# fillers, but losing more than 5% of alphanumeric content is too risky for a
# final document. Prefer the complete rolling transcript over partial labels.
MIN_RETRANSCRIPTION_CONTENT_PERCENT = 95
# Full-file speaker alignment is used only below five minutes. Bound its
# quadratic work even if a malformed model result contains far too many words.
# Larger inputs use the existing lossless rolling-block fallback instead.
MAX_SPEAKER_ALIGNMENT_CELLS = 4_000_000
# Canonical names come from the pinned Qwen3-ASR model's support_languages
# config. TranscriptionResult.language is the model-detected canonical name
# (or "unknown"/"" when detection does not settle). Trust a supported
# detected language instead of treating every non-Latin/Hangul script as a
# Korean/English hallucination.
SUPPORTED_ASR_LANGUAGES = {
    name.casefold(): name
    for name in (
        "Chinese",
        "English",
        "Cantonese",
        "Arabic",
        "German",
        "French",
        "Spanish",
        "Portuguese",
        "Indonesian",
        "Italian",
        "Korean",
        "Russian",
        "Thai",
        "Vietnamese",
        "Japanese",
        "Turkish",
        "Hindi",
        "Malay",
        "Dutch",
        "Swedish",
        "Danish",
        "Finnish",
        "Polish",
        "Czech",
        "Filipino",
        "Persian",
        "Greek",
        "Romanian",
        "Hungarian",
        "Macedonian",
    )
}
SUPPORTED_ASR_LANGUAGE_ALIASES = {
    "en": "English",
    "ko": "Korean",
    "kr": "Korean",
    "ko-kr": "Korean",
    "zh": "Chinese",
    "zh-cn": "Chinese",
    "zh-tw": "Chinese",
    "cmn": "Chinese",
    "ja": "Japanese",
    "ja-jp": "Japanese",
}
LANGUAGE_EXPECTED_SCRIPTS = {
    "Chinese": {"Han"},
    "Cantonese": {"Han"},
    "Japanese": {"Han", "Kana"},
    "Hindi": {"Devanagari"},
    "Arabic": {"Arabic"},
    "Persian": {"Arabic"},
    "Russian": {"Cyrillic"},
    "Macedonian": {"Cyrillic"},
    "Greek": {"Greek"},
    "Thai": {"Thai"},
    "German": {"Latin"},
    "French": {"Latin"},
    "Spanish": {"Latin"},
    "Portuguese": {"Latin"},
    "Indonesian": {"Latin"},
    "Italian": {"Latin"},
    "Vietnamese": {"Latin"},
    "Turkish": {"Latin"},
    "Malay": {"Latin"},
    "Dutch": {"Latin"},
    "Swedish": {"Latin"},
    "Danish": {"Latin"},
    "Finnish": {"Latin"},
    "Polish": {"Latin"},
    "Czech": {"Latin"},
    "Filipino": {"Latin"},
    "Romanian": {"Latin"},
    "Hungarian": {"Latin"},
}
MIN_SCRIPT_EVIDENCE_LETTERS = 8
MIN_MATCHING_SCRIPT_LETTERS = 3
MIN_MATCHING_SCRIPT_RATIO = 0.12
KOREAN_COLLOQUIAL_NORMALIZATIONS = {
    "근데": "그런데",
    "보면은": "보면",
    "하면은": "하면",
    "있으면은": "있으면",
    "없으면은": "없으면",
    "그러면은": "그러면",
    "아니면은": "아니면",
    "거면은": "거면",
    "왜냐면": "왜냐하면",
}
KOREAN_SINO_DIGITS = {
    "영": 0,
    "공": 0,
    "일": 1,
    "이": 2,
    "삼": 3,
    "사": 4,
    "오": 5,
    "육": 6,
    "칠": 7,
    "팔": 8,
    "구": 9,
}
KOREAN_SINO_SMALL_UNITS = {"십": 10, "백": 100, "천": 1_000}
KOREAN_SINO_LARGE_UNITS = {"만": 10_000, "억": 100_000_000, "조": 1_000_000_000_000}
KOREAN_NATIVE_ONES = {
    "한": 1,
    "하나": 1,
    "두": 2,
    "둘": 2,
    "세": 3,
    "셋": 3,
    "네": 4,
    "넷": 4,
    "다섯": 5,
    "여섯": 6,
    "일곱": 7,
    "여덟": 8,
    "아홉": 9,
}
KOREAN_NATIVE_TENS = {
    "열": 10,
    "스물": 20,
    "스무": 20,
    "서른": 30,
    "마흔": 40,
    "쉰": 50,
    "예순": 60,
    "일흔": 70,
    "여든": 80,
    "아흔": 90,
}
KOREAN_NATIVE_SAFE_UNITS = {
    "시간",
    "시",
    "킬로그램",
    "키로그램",
    "킬로",
    "키로",
    "센티미터",
    "밀리미터",
    "센티",
    "미터",
    "그램",
    "기가",
    "메가",
    "퍼센트",
    "살",
}
KOREAN_NUMERAL_UNITS = (
    "킬로그램",
    "키로그램",
    "센티미터",
    "밀리미터",
    "퍼센트",
    "개월",
    "만원",
    "시간",
    "킬로",
    "키로",
    "센티",
    "미터",
    "그램",
    "기가",
    "메가",
    "번째",
    "년",
    "월",
    "주",
    "시",
    "분",
    "초",
    "명",
    "개",
    "대",
    "회",
    "번",
    "장",
    "권",
    "곡",
    "층",
    "살",
    "원",
)
KOREAN_NUMERAL_SUFFIXES = (
    "에서부터",
    "으로부터",
    "까지는",
    "까지도",
    "까지만",
    "부터는",
    "부터도",
    "에서는",
    "에서도",
    "에서만",
    "으로는",
    "으로도",
    "으로만",
    "로부터",
    "만큼",
    "밖에",
    "처럼",
    "보다",
    "에서",
    "으로",
    "까지",
    "부터",
    "로는",
    "로도",
    "로만",
    "에는",
    "에도",
    "에만",
    "마다",
    "동안",
    "짜리",
    "가량",
    "정도",
    "에",
    "은",
    "는",
    "이",
    "가",
    "을",
    "를",
    "의",
    "와",
    "과",
    "도",
    "만",
    "쯤",
    "경",
    "씩",
    "로",
    "전",
    "후",
    "대",
    "간",
    "째",
)
_KOREAN_NATIVE_NUMBER_PATTERN = (
    rf"(?:{'|'.join(KOREAN_NATIVE_TENS)})(?:\s*(?:{'|'.join(KOREAN_NATIVE_ONES)}))?"
    rf"|(?:{'|'.join(KOREAN_NATIVE_ONES)})"
)
KOREAN_NUMERAL_PATTERN = re.compile(
    rf"(?<![가-힣A-Za-z0-9])"
    rf"(?P<number>(?:[영공일이삼사오육칠팔구십백천만억조]+|{_KOREAN_NATIVE_NUMBER_PATTERN}))"
    rf"\s+(?P<unit>{'|'.join(KOREAN_NUMERAL_UNITS)})"
    rf"(?P<suffix>{'|'.join(KOREAN_NUMERAL_SUFFIXES)})?"
    rf"(?=$|[\s,.!?…:;)\]}}])",
)


@dataclass(frozen=True)
class SpeakerProbabilityTimeline:
    """Frame-level speaker probabilities on the original audio clock."""

    values: Any
    start_seconds: float
    frame_seconds: float


def configure_streaming_join_rules(aliases: set[str] | None = None) -> None:
    """Use word boundaries when joining Korean streaming chunks.

    mlx-qwen3-asr 0.3.5 groups Korean with unspaced Chinese/Japanese text,
    which glues every independently decoded chunk together. Korean orthography
    is space-delimited, so it must use the Latin-style word overlap path.
    """
    if aliases is None:
        import mlx_qwen3_asr.streaming as streaming

        aliases = streaming._CJK_LANG_ALIASES
    for alias in ("korean", "ko", "kr"):
        aliases.discard(alias)


def sanitize_stream_text(text: str, language: str | None) -> str:
    """Remove short foreign-script hallucinations from Korean/English output."""
    value = str(text or "")
    unexpected_run = 0
    longest_unexpected_run = 0
    for character in value:
        if not unicodedata.category(character).startswith("L"):
            unexpected_run = 0
            continue
        codepoint = ord(character)
        is_latin = 0x0041 <= codepoint <= 0x007A or 0x00C0 <= codepoint <= 0x024F
        is_hangul = (
            0x1100 <= codepoint <= 0x11FF
            or 0x3130 <= codepoint <= 0x318F
            or 0xAC00 <= codepoint <= 0xD7AF
        )
        unexpected_run = 0 if is_latin or is_hangul else unexpected_run + 1
        longest_unexpected_run = max(longest_unexpected_run, unexpected_run)
    if not contains_unexpected_script(value) and longest_unexpected_run < 3:
        return value.strip()
    normalized_language = str(language or "").strip().lower()
    if normalized_language not in {"", "unknown", "korean", "ko", "kr", "english", "en"}:
        return value.strip()

    cleaned: list[str] = []
    for character in value:
        if not unicodedata.category(character).startswith("L"):
            cleaned.append(character)
            continue
        codepoint = ord(character)
        is_latin = 0x0041 <= codepoint <= 0x007A or 0x00C0 <= codepoint <= 0x024F
        is_hangul = (
            0x1100 <= codepoint <= 0x11FF
            or 0x3130 <= codepoint <= 0x318F
            or 0xAC00 <= codepoint <= 0xD7AF
        )
        cleaned.append(character if is_latin or is_hangul else " ")
    result = re.sub(r"\s+", " ", "".join(cleaned)).strip()
    return re.sub(r"\s+([.,!?…])", r"\1", result)


def parse_korean_sino_number(text: str) -> int | None:
    """Parse a well-formed Sino-Korean cardinal without guessing digit strings."""
    compact = re.sub(r"\s+", "", str(text or ""))
    if not compact:
        return None
    total = 0
    section = 0
    current_digit: int | None = None
    previous_small_unit = 10_000
    previous_large_unit = 10**15
    saw_number = False
    for character in compact:
        if character in KOREAN_SINO_DIGITS:
            # Adjacent digit names are commonly phone/account identifiers,
            # where converting the whole run as a cardinal would be wrong.
            if current_digit is not None:
                return None
            current_digit = KOREAN_SINO_DIGITS[character]
            saw_number = True
            continue
        if character in KOREAN_SINO_SMALL_UNITS:
            unit = KOREAN_SINO_SMALL_UNITS[character]
            if unit >= previous_small_unit:
                return None
            # Zero cannot multiply a Korean cardinal unit (``영십`` is
            # malformed rather than an alternative way to say zero).
            if current_digit == 0:
                return None
            section += (current_digit if current_digit is not None else 1) * unit
            current_digit = None
            previous_small_unit = unit
            saw_number = True
            continue
        if character in KOREAN_SINO_LARGE_UNITS:
            unit = KOREAN_SINO_LARGE_UNITS[character]
            if unit >= previous_large_unit:
                return None
            # A bare large unit may be valid in conversational shorthand, but
            # accepting it lets a spaced coefficient be partially rewritten:
            # ``십 만 원`` -> ``십 1만 원``. Preserve such input.
            if current_digit == 0 or (section == 0 and current_digit is None):
                return None
            section += current_digit if current_digit is not None else 0
            total += section * unit
            section = 0
            current_digit = None
            previous_small_unit = 10_000
            previous_large_unit = unit
            saw_number = True
            continue
        return None
    if not saw_number:
        return None
    # A zero digit after an accumulated unit/section is malformed in Korean
    # cardinals (``십만영``, ``백영``, ``십공``). Accepting it would
    # silently drop the spoken zero during formatting.
    if current_digit == 0 and (section > 0 or total > 0):
        return None
    return total + section + (current_digit if current_digit is not None else 0)


def parse_korean_native_number(text: str) -> int | None:
    """Parse the small native numerals used with time and measurements."""
    compact = re.sub(r"\s+", "", str(text or ""))
    if compact in KOREAN_NATIVE_ONES:
        return KOREAN_NATIVE_ONES[compact]
    for tens, tens_value in KOREAN_NATIVE_TENS.items():
        if compact == tens:
            return tens_value
        if compact.startswith(tens):
            ones = compact[len(tens):]
            if ones in KOREAN_NATIVE_ONES:
                return tens_value + KOREAN_NATIVE_ONES[ones]
    return None


def format_large_korean_number(text: str) -> str | None:
    """Keep familiar 조/억/만 grouping while replacing spoken coefficients."""
    remaining = re.sub(r"\s+", "", str(text or ""))
    formatted: list[str] = []
    for marker in ("조", "억", "만"):
        if marker not in remaining:
            continue
        coefficient_text, remaining = remaining.split(marker, 1)
        coefficient = parse_korean_sino_number(coefficient_text) if coefficient_text else 1
        if coefficient is None:
            return None
        if 1_000 <= coefficient < 10_000 and coefficient % 1_000 == 0:
            formatted.append(f"{coefficient // 1_000}천{marker}")
        else:
            formatted.append(f"{coefficient}{marker}")
    if remaining:
        remainder = parse_korean_sino_number(remaining)
        if remainder is None:
            return None
        if 1_000 <= remainder < 10_000 and remainder % 1_000 == 0:
            formatted.append(f"{remainder // 1_000}천")
        else:
            formatted.append(str(remainder))
    return "".join(formatted)


def nearby_korean_clause(text: str, start: int, end: int) -> tuple[str, str]:
    """Return bounded same-sentence context around a numeral candidate."""
    before = text[max(0, start - 96):start]
    after = text[end:min(len(text), end + 96)]
    return (
        re.split(r"[.!?…]\s*", before)[-1],
        re.split(r"[.!?…]", after, maxsplit=1)[0],
    )


def has_explicit_korean_clock_context(text: str, match: re.Match[str]) -> bool:
    """Distinguish clock hours from the homonymous noun for poetry."""
    before, after = nearby_korean_clause(text, match.start(), match.end())
    suffix = match.group("suffix") or ""
    if re.search(r"(?:오전|오후|새벽|아침|저녁|밤|낮|정오|자정)\s*$", before):
        return True
    # Approximate clock expressions are self-disambiguating in normal Korean;
    # counting poems would require a classifier such as ``편``.
    if suffix in {"쯤", "경"}:
        return True
    if re.match(
        r"\s*(?:취침|기상|알람|예약|출발|도착|회의|약속|시작|종료|일어나)",
        after,
    ):
        return True
    return suffix.startswith("에") and bool(
        re.search(r"(?:일어나|졸리|잠들|자야|자러|잤|알람)", after)
    )


def has_explicit_korean_minute_context(text: str, match: re.Match[str]) -> bool:
    """Distinguish elapsed/clock minutes from the honorific people counter."""
    before, after = nearby_korean_clause(text, match.start(), match.end())
    suffix = match.group("suffix") or ""
    if re.search(
        r"(?:지원자|참석자|손님|고객|환자|선생님|교수님|어르신|후보자)\s*$",
        before,
    ) or re.match(r"\s*(?:모셨|오셨|계셨|참석|지원|선발)", after):
        return False
    if suffix in {"동안", "간", "정도", "가량", "쯤", "전", "후", "마다"}:
        return True
    if re.search(r"(?:\d+|[가-힣]+)\s*시\s*$", before):
        return True
    if re.search(
        r"(?:회의|수업|통화|운동|휴식|녹화|재생|대기|소요)(?:은|는|이|가)?\s*$",
        before,
    ):
        return True
    return bool(
        re.match(
            r"\s*(?:동안|간|만에|정도|가량|쯤|전|후|걸리|소요|기다리|지나|휴식|쉬)",
            after,
        )
    )


def has_explicit_korean_duration_context(text: str, match: re.Match[str]) -> bool:
    """Require duration evidence before rewriting possessive-looking ``네 시간``."""
    before, after = nearby_korean_clause(text, match.start(), match.end())
    suffix = match.group("suffix") or ""
    if suffix in {"동안", "간", "정도", "가량", "쯤", "만큼"}:
        return True
    if re.search(
        r"(?:회의|수업|통화|운동|작업|수면|근무|비행|여행|소요)(?:은|는|이|가)?\s*$",
        before,
    ):
        return True
    return bool(re.match(r"\s*(?:동안|간|정도|가량|쯤|걸리|소요)", after))


def format_unambiguous_korean_numerals(text: str) -> str:
    """Use digits for clear finalized quantities without rewriting Korean words.

    Native counters such as ``두 분`` and ambiguous lexical sequences such as
    ``이 시`` are intentionally left alone. This pass is limited to finalized
    Korean blocks; previews and non-Korean transcripts remain verbatim.
    """
    value = str(text or "")

    def replacement(match: re.Match[str]) -> str:
        number_text = match.group("number")
        compact_number = re.sub(r"\s+", "", number_text)
        unit = match.group("unit")
        suffix = match.group("suffix") or ""
        # If another numeric token sits immediately before this match, the
        # regex captured only the tail of a spaced cardinal. Rewriting that
        # tail creates corrupt hybrids such as ``백 20년`` or
        # ``십 1만 원``. Native compounds such as ``스물 한`` are
        # already consumed by the match itself and do not hit this guard.
        prefix = value[:match.start()]
        previous_token_match = re.search(r"([가-힣0-9]+)\s+$", prefix)
        if previous_token_match:
            previous_token = previous_token_match.group(1)
            if (
                previous_token.isdigit()
                or parse_korean_sino_number(previous_token) is not None
                or parse_korean_native_number(previous_token) is not None
            ):
                candidate_value = (
                    parse_korean_native_number(compact_number)
                    if parse_korean_native_number(compact_number) is not None
                    else parse_korean_sino_number(compact_number)
                )
                approximate_count = (
                    previous_token == "한"
                    and candidate_value is not None
                    and candidate_value >= 10
                    and unit == "번"
                    and suffix == "씩"
                )
                acknowledged_clock = (
                    previous_token == "네"
                    and unit == "시"
                    and has_explicit_korean_clock_context(value, match)
                )
                if not approximate_count and not acknowledged_clock:
                    return match.group(0)
        native_value = parse_korean_native_number(compact_number)
        if native_value is not None:
            if unit not in KOREAN_NATIVE_SAFE_UNITS:
                return match.group(0)
            if unit == "시" and not has_explicit_korean_clock_context(value, match):
                return match.group(0)
            if (
                compact_number == "네"
                and unit == "시간"
                and not has_explicit_korean_duration_context(value, match)
            ):
                return match.group(0)
            # ``네 살`` is both the age four and possessive ``your flesh``.
            # It brought no measured benchmark gain, so preserve it outright.
            if compact_number == "네" and unit == "살":
                return match.group(0)
            number_value = native_value
        else:
            number_value = parse_korean_sino_number(compact_number)
            if number_value is None:
                return match.group(0)
            # Every single Sino digit has lexical-homonym risk (for example
            # ``이 미터`` = "this meter"). It produced none of the
            # measured wins, so require a multiplier such as 십/백.
            if number_value < 10:
                return match.group(0)

        if unit == "분" and not has_explicit_korean_minute_context(value, match):
            return match.group(0)
        # Native ``네`` is also possessive "your". Only the independently
        # disambiguated clock/duration paths above are safe enough to rewrite.
        if compact_number == "네" and unit not in {"시", "시간"}:
            return match.group(0)

        if any(marker in compact_number for marker in KOREAN_SINO_LARGE_UNITS):
            formatted = format_large_korean_number(compact_number)
            if formatted is None:
                return match.group(0)
        else:
            formatted = str(number_value)
        separator = " " if unit == "원" and any(
            marker in compact_number for marker in KOREAN_SINO_LARGE_UNITS
        ) else ""
        return f"{formatted}{separator}{unit}{suffix}"

    return KOREAN_NUMERAL_PATTERN.sub(replacement, value)


def polish_meeting_transcript(text: str, language: str | None) -> str:
    """Conservatively tidy finalized Korean blocks without rewriting meaning.

    The two-second preview remains verbatim and responsive. Only the accuracy
    pass removes isolated hesitation sounds and normalizes a small set of
    colloquial forms that repeatedly differed from human-edited meeting notes.
    """
    value = re.sub(r"\s+", " ", str(text or "")).strip()
    if str(language or "").strip().lower() not in {"korean", "ko", "kr"}:
        return value
    value = re.sub(
        r"(?<!\S)(?:어+|음+|으+|아+)(?:[,.!?…]+)?(?=\s|$)\s*",
        "",
        value,
    )
    for source, target in KOREAN_COLLOQUIAL_NORMALIZATIONS.items():
        value = re.sub(
            rf"(?<!\S){re.escape(source)}(?=[,.!?…]?\s|[,.!?…]?$)",
            target,
            value,
        )
    value = format_unambiguous_korean_numerals(value)
    value = re.sub(r"\s+([,.!?…])", r"\1", re.sub(r"\s+", " ", value)).strip()
    return value


def speech_activity_ratio(raw_segments: list[Any], start: float, end: float) -> float:
    """Return unioned speech coverage so overlapping speakers count once."""
    duration = max(0.0, end - start)
    if duration <= 0:
        return 0.0
    intervals: list[tuple[float, float]] = []
    for segment in raw_segments:
        segment_start = max(start, float(getattr(segment, "start", 0.0)))
        segment_end = min(end, float(getattr(segment, "end", 0.0)))
        if segment_end > segment_start:
            intervals.append((segment_start, segment_end))
    intervals.sort()
    covered = 0.0
    current_start: float | None = None
    current_end = 0.0
    for interval_start, interval_end in intervals:
        if current_start is None:
            current_start, current_end = interval_start, interval_end
        elif interval_start <= current_end:
            current_end = max(current_end, interval_end)
        else:
            covered += current_end - current_start
            current_start, current_end = interval_start, interval_end
    if current_start is not None:
        covered += current_end - current_start
    return min(1.0, covered / duration)


def should_suppress_low_speech_hallucination(
    language: str | None,
    activity_ratio: float | None,
    text: str,
) -> bool:
    """Reject low-speech guesses with unsupported or incoherent language evidence."""
    if activity_ratio is None or activity_ratio >= 0.22:
        return False
    normalized = str(language or "").strip().casefold().replace("_", "-")
    # Preserve the established Korean/English and unresolved-language paths.
    # Their foreign-script cleanup/retry is handled separately below.
    if normalized in {"", "unknown"}:
        return False
    detected = canonical_supported_language(language)
    if detected in {"Korean", "English"}:
        return False
    if detected is None:
        return True

    expected_scripts = LANGUAGE_EXPECTED_SCRIPTS.get(detected)
    if not expected_scripts:
        return False
    letters = [
        character
        for character in unicodedata.normalize("NFC", str(text or ""))
        if unicodedata.category(character).startswith("L")
    ]
    # An empty refined result must remain suppressed so the low-confidence
    # streaming preview cannot put the rejected hallucination back. Short
    # non-empty phrases do not provide enough evidence to reject safely.
    if not letters:
        return True
    if len(letters) < MIN_SCRIPT_EVIDENCE_LETTERS:
        return False
    matching = sum(
        1
        for character in letters
        if unicode_letter_script(character) in expected_scripts
    )
    return (
        matching < MIN_MATCHING_SCRIPT_LETTERS
        and matching / len(letters) < MIN_MATCHING_SCRIPT_RATIO
    )


def unicode_letter_script(character: str) -> str | None:
    """Return the coarse writing system needed by the ASR language guard."""
    if not character or not unicodedata.category(character).startswith("L"):
        return None
    name = unicodedata.name(character, "")
    if "CJK UNIFIED IDEOGRAPH" in name or "CJK COMPATIBILITY IDEOGRAPH" in name:
        return "Han"
    if "HIRAGANA" in name or "KATAKANA" in name:
        return "Kana"
    for marker, script in (
        ("DEVANAGARI", "Devanagari"),
        ("ARABIC", "Arabic"),
        ("CYRILLIC", "Cyrillic"),
        ("GREEK", "Greek"),
        ("THAI", "Thai"),
        ("HANGUL", "Hangul"),
        ("LATIN", "Latin"),
    ):
        if marker in name:
            return script
    return None


def canonical_supported_language(language: str | None) -> str | None:
    normalized = str(language or "").strip().casefold().replace("_", "-")
    return SUPPORTED_ASR_LANGUAGE_ALIASES.get(
        normalized,
        SUPPORTED_ASR_LANGUAGES.get(normalized),
    )


def normalize_speaker(value: Any) -> int | None:
    if value is None:
        return None
    text = str(value)
    digits = "".join(character for character in text if character.isdigit())
    if not digits:
        return None
    return min(4, int(digits) + 1)


def contains_unexpected_script(text: str) -> bool:
    letter_count = 0
    unexpected_count = 0
    for character in text:
        if not unicodedata.category(character).startswith("L"):
            continue
        letter_count += 1
        codepoint = ord(character)
        is_latin = (
            0x0041 <= codepoint <= 0x007A
            or 0x00C0 <= codepoint <= 0x024F
        )
        is_hangul = (
            0x1100 <= codepoint <= 0x11FF
            or 0x3130 <= codepoint <= 0x318F
            or 0xAC00 <= codepoint <= 0xD7AF
        )
        if not is_latin and not is_hangul:
            unexpected_count += 1
    return unexpected_count >= 3 and unexpected_count / max(1, letter_count) >= 0.08


def needs_korean_retry(text: str, language: str | None) -> bool:
    if has_excessive_repetition(text):
        return True
    detected = canonical_supported_language(language)
    return contains_unexpected_script(text) and detected in {None, "Korean", "English"}


def retry_language(text: str, language: str | None) -> str:
    """Choose the closest supported meeting language for a bad auto decode."""
    detected = canonical_supported_language(language)
    if detected is not None:
        return detected
    hangul = sum(1 for character in text if 0xAC00 <= ord(character) <= 0xD7AF)
    latin = sum(
        1
        for character in text
        if 0x0041 <= ord(character) <= 0x007A or 0x00C0 <= ord(character) <= 0x024F
    )
    return "English" if latin > hangul and latin >= 3 else "Korean"


def has_excessive_repetition(text: str) -> bool:
    tokens = [token.strip(".,!?·:;()[]{}\"'").lower() for token in text.split()]
    tokens = [token for token in tokens if token]
    if len(tokens) < 6:
        return False
    for width in range(1, min(5, len(tokens) // 3) + 1):
        counts: dict[tuple[str, ...], int] = {}
        for index in range(len(tokens) - width + 1):
            phrase = tuple(tokens[index:index + width])
            counts[phrase] = counts.get(phrase, 0) + 1
        repetitions = max(counts.values(), default=0)
        if repetitions >= 3 and repetitions * width / len(tokens) >= 0.42:
            return True
    return False


def transcribe_meeting_audio(
    session: Any,
    audio: Any,
    sample_rate: int,
    *,
    speech_activity: float | None = None,
) -> tuple[str, str]:
    if len(audio) < max(1, int(sample_rate * 0.25)):
        return "", ""
    result = session.transcribe(
        (audio, sample_rate),
        context=MEETING_CONTEXT,
    )
    if bool(getattr(result, "truncated", False)):
        try:
            expanded = session.transcribe(
                (audio, sample_rate),
                context=MEETING_CONTEXT,
                max_new_tokens=512,
            )
        except Exception:
            expanded = None
        expanded_text = str(getattr(expanded, "text", "") or "").strip()
        if (
            expanded_text
            and not bool(getattr(expanded, "truncated", False))
        ):
            result = expanded
    text = str(getattr(result, "text", "") or "").strip()
    language = str(getattr(result, "language", "") or "")
    if should_suppress_low_speech_hallucination(language, speech_activity, text):
        return "", language
    if needs_korean_retry(text, language):
        retry_as = retry_language(text, language)
        try:
            retry = session.transcribe(
                (audio, sample_rate),
                context=MEETING_CONTEXT,
                language=retry_as,
            )
        except Exception:
            # The first decode is still useful even if a best-effort cleanup
            # pass fails (for example because of transient MLX pressure).
            # Do not turn that optional retry into a whole-worker error.
            return polish_meeting_transcript(text, language), language
        retry_text = str(getattr(retry, "text", "") or "").strip()
        if (
            retry_text
            and not needs_korean_retry(retry_text, retry_as)
        ):
            return polish_meeting_transcript(retry_text, retry_as), retry_as
        if needs_korean_retry(text, language):
            return "", language
    return polish_meeting_transcript(text, language), language


def transcribe_audio_windowed(
    session: Any,
    audio: Any,
    sample_rate: int,
    max_window_sec: float = 30.0,
) -> str:
    window_samples = max(1, int(sample_rate * max_window_sec))
    result = ""
    for start in range(0, len(audio), window_samples):
        window = audio[start:start + window_samples]
        if len(window) == 0:
            continue
        text, _ = transcribe_meeting_audio(session, window, sample_rate)
        if text:
            # These windows are contiguous, not overlapping. Repeated words
            # at the boundary may be genuine speech and must be preserved.
            result = join_transcript(result, text)
    return result


def join_transcript(*parts: str) -> str:
    return " ".join(part.strip() for part in parts if part and part.strip()).strip()


def merge_transcript_text(prefix: str, suffix: str, max_overlap_words: int = 12) -> str:
    """Join overlapping ASR windows without repeating their shared words."""
    left = str(prefix or "").strip()
    right = str(suffix or "").strip()
    if not left:
        return right
    if not right:
        return left
    left_words = left.split()
    right_words = right.split()

    def key(word: str) -> str:
        return re.sub(r"[^\w]+", "", word, flags=re.UNICODE).lower()

    limit = min(max_overlap_words, len(left_words), len(right_words))
    overlap = 0
    for width in range(limit, 0, -1):
        if [key(word) for word in left_words[-width:]] == [key(word) for word in right_words[:width]]:
            overlap = width
            break
    return join_transcript(left, " ".join(right_words[overlap:]))


def choose_silence_boundary(
    audio: Any,
    sample_rate: int,
    target_sec: float = ROLLING_REFINE_SECONDS,
    min_sec: float = REFINE_MIN_SECONDS,
    max_sec: float = REFINE_MAX_SECONDS,
) -> int:
    """Pick a quiet boundary near the target instead of cutting a syllable."""
    import numpy as np

    values = np.asarray(audio, dtype=np.float32)
    minimum = min(len(values), max(1, int(min_sec * sample_rate)))
    maximum = min(len(values), max(minimum, int(max_sec * sample_rate)))
    if maximum <= minimum:
        return maximum
    frame = max(1, int(0.24 * sample_rate))
    stride = max(1, int(0.08 * sample_rate))
    target = min(maximum, max(minimum, int(target_sec * sample_rate)))
    best_boundary = target
    best_score = float("inf")
    for center in range(minimum, maximum + 1, stride):
        start = max(0, center - frame // 2)
        end = min(len(values), start + frame)
        if end <= start:
            continue
        rms = float(np.sqrt(np.mean(np.square(values[start:end], dtype=np.float64))))
        distance_seconds = abs(center - target) / float(sample_rate)
        # A 6 dB quieter valley may move the boundary roughly two seconds.
        score = float(np.log10(rms + 1e-5)) + distance_seconds * 0.075
        if score < best_score:
            best_score = score
            best_boundary = center
    return max(minimum, min(maximum, best_boundary))


def transcribe_audio_adaptive(
    session: Any,
    audio: Any,
    sample_rate: int,
    buffer_sec: float = REFINE_BUFFER_SECONDS,
    overlap_sec: float = REFINE_OVERLAP_SECONDS,
) -> str:
    """Transcribe at quiet boundaries with a small context overlap."""
    import numpy as np

    values = np.asarray(audio, dtype=np.float32)
    buffer_samples = max(1, int(buffer_sec * sample_rate))
    overlap_samples = max(0, int(overlap_sec * sample_rate))
    cursor = 0
    result = ""
    while cursor < len(values):
        remaining = len(values) - cursor
        if remaining <= buffer_samples:
            boundary = remaining
        else:
            boundary = choose_silence_boundary(values[cursor:cursor + buffer_samples], sample_rate)
        start = max(0, cursor - (overlap_samples if cursor else 0))
        end = min(len(values), cursor + boundary + (overlap_samples if cursor + boundary < len(values) else 0))
        text, _ = transcribe_meeting_audio(session, values[start:end], sample_rate)
        result = merge_transcript_text(result, text)
        cursor += max(1, boundary)
    return result


def choose_live_speaker(result: Any) -> int | None:
    try:
        import numpy as np

        probabilities = np.asarray(getattr(result, "speaker_probs", None))
        if probabilities.ndim == 2 and probabilities.shape[0] > 0:
            means = probabilities.mean(axis=0)
            order = np.argsort(means)[::-1]
            top = int(order[0])
            runner_up = float(means[order[1]]) if len(order) > 1 else 0.0
            active_duration = float(np.count_nonzero(probabilities[:, top] >= 0.65)) * 0.08
            if float(means[top]) >= 0.68 and float(means[top]) - runner_up >= 0.12 and active_duration >= 0.64:
                return top + 1
    except Exception:
        pass

    segments = list(getattr(result, "segments", []) or [])
    if not segments:
        return None
    durations: dict[int, float] = {}
    for segment in segments:
        speaker = normalize_speaker(getattr(segment, "speaker", None))
        if speaker is None:
            continue
        duration = max(0.0, float(getattr(segment, "end", 0.0)) - float(getattr(segment, "start", 0.0)))
        durations[speaker] = durations.get(speaker, 0.0) + duration
    if not durations:
        return None
    speaker, duration = max(durations.items(), key=lambda item: item[1])
    return speaker if duration >= 0.8 else None


def mean_speaker_probability(
    speaker_timeline: SpeakerProbabilityTimeline | None,
    speaker_index: int,
    start: float,
    end: float,
) -> float | None:
    try:
        if not isinstance(speaker_timeline, SpeakerProbabilityTimeline):
            return None
        frame_count = len(speaker_timeline.values)
        origin = float(speaker_timeline.start_seconds)
        frame_seconds = float(speaker_timeline.frame_seconds)
        if (
            frame_count == 0
            or speaker_index < 0
            or not math.isfinite(origin)
            or not math.isfinite(frame_seconds)
            or frame_seconds <= 0.0
        ):
            return None

        interval_start = max(float(start), origin)
        interval_end = min(
            float(end),
            origin + frame_count * frame_seconds,
        )
        if (
            not math.isfinite(interval_start)
            or not math.isfinite(interval_end)
            or interval_end <= interval_start
        ):
            return None

        # Sortformer frame N represents [N * frame_seconds, (N + 1) *
        # frame_seconds). Tiny epsilons keep exact decimal boundaries from
        # selecting the neighboring frame due to binary float rounding.
        first = int(math.floor(
            (interval_start - origin) / frame_seconds + 1e-9
        ))
        last = int(math.ceil(
            (interval_end - origin) / frame_seconds - 1e-9
        ))
        first = max(0, min(frame_count - 1, first))
        last = max(first + 1, min(frame_count, last))
        values = [
            float(speaker_timeline.values[index][speaker_index])
            for index in range(first, last)
        ]
        if not all(math.isfinite(value) for value in values):
            return None
        return sum(values) / len(values) if values else None
    except Exception:
        return None


def merge_turns(
    raw_segments: list[Any],
    duration: float,
    speaker_timeline: SpeakerProbabilityTimeline | None = None,
) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for raw in raw_segments:
        speaker = normalize_speaker(getattr(raw, "speaker", None))
        start = max(0.0, float(getattr(raw, "start", 0.0)))
        end = min(duration, float(getattr(raw, "end", 0.0)))
        if speaker is None or end - start < 0.7:
            continue
        candidates.append({
            "speaker": speaker,
            "start": start,
            "end": end,
            "original_duration": end - start,
        })
    candidates.sort(key=lambda turn: (turn["start"], turn["end"], turn["speaker"]))

    # Split the diarizer output at every boundary before resolving overlaps.
    # Mutating only the previously emitted turn loses its unconsumed tail when
    # a short competing speaker wins in the middle of a long segment. Atomic
    # intervals let that underlying speaker resume after the overlap.
    turns: list[dict[str, Any]] = []
    boundaries = sorted({value for turn in candidates for value in (turn["start"], turn["end"])})
    for start, end in zip(boundaries, boundaries[1:]):
        if end <= start:
            continue
        active = [
            turn
            for turn in candidates
            if turn["start"] < end and turn["end"] > start
        ]
        if not active:
            continue
        speakers = sorted({turn["speaker"] for turn in active})
        if len(speakers) == 1:
            speaker = speakers[0]
        else:
            fallback_durations = {
                candidate_speaker: max(
                    turn["original_duration"]
                    for turn in active
                    if turn["speaker"] == candidate_speaker
                )
                for candidate_speaker in speakers
            }
            scores = {
                candidate_speaker: mean_speaker_probability(
                    speaker_timeline,
                    candidate_speaker - 1,
                    start,
                    end,
                )
                for candidate_speaker in speakers
            }
            scored_speakers = [
                candidate_speaker
                for candidate_speaker in speakers
                if scores[candidate_speaker] is not None
            ]
            if scored_speakers:
                speaker = max(
                    scored_speakers,
                    key=lambda candidate_speaker: (
                        scores[candidate_speaker],
                        fallback_durations[candidate_speaker],
                        -candidate_speaker,
                    ),
                )
            else:
                speaker = max(
                    speakers,
                    key=lambda candidate_speaker: (
                        fallback_durations[candidate_speaker],
                        -candidate_speaker,
                    ),
                )
        if turns and turns[-1]["speaker"] == speaker and start - turns[-1]["end"] <= 0.8:
            turns[-1]["end"] = end
        else:
            turns.append({"speaker": speaker, "start": start, "end": end})

    if not turns:
        return turns

    # Scale false-speaker pruning by actual detected speech, not wall-clock
    # duration. Otherwise appending silence to an unchanged conversation can
    # raise the threshold enough to erase every short participant (for
    # example, a 49-second three-speaker clip became one speaker when padded
    # to two minutes). `turns` is already an atomic, non-overlapping union of
    # all accepted raw speech, so its summed duration is the relevant base.
    detected_speech_duration = sum(
        turn["end"] - turn["start"]
        for turn in turns
    )
    minimum_total = max(1.5, detected_speech_duration * 0.025)
    raw_totals: dict[int, float] = {}
    raw_intervals: dict[int, list[tuple[float, float]]] = {}
    for candidate in candidates:
        speaker = candidate["speaker"]
        raw_totals[speaker] = (
            raw_totals.get(speaker, 0.0) + candidate["original_duration"]
        )
        raw_intervals.setdefault(speaker, []).append(
            (candidate["start"], candidate["end"])
        )
    longest_raw: dict[int, float] = {}
    for speaker, intervals in raw_intervals.items():
        ordered_intervals = sorted(intervals)
        contiguous_start, contiguous_end = ordered_intervals[0]
        longest = contiguous_end - contiguous_start
        for start, end in ordered_intervals[1:]:
            if start <= contiguous_end + 1e-9:
                contiguous_end = max(contiguous_end, end)
            else:
                longest = max(longest, contiguous_end - contiguous_start)
                contiguous_start, contiguous_end = start, end
        longest_raw[speaker] = max(longest, contiguous_end - contiguous_start)
    selected_totals: dict[int, float] = {}
    for turn in turns:
        speaker = turn["speaker"]
        selected_totals[speaker] = (
            selected_totals.get(speaker, 0.0) + turn["end"] - turn["start"]
        )

    # A quieter real speaker can be completely hidden when every one of its
    # raw intervals overlaps a stronger speaker. Rescue only speakers that the
    # atomic winner pass selected for zero time and that have both enough total
    # evidence and one sustained contiguous raw span. Requiring both avoids
    # promoting scattered short noisy guesses whose durations merely add up.
    rescued_speakers = {
        speaker
        for speaker, raw_total in raw_totals.items()
        if speaker not in selected_totals
        and raw_total >= minimum_total
        and longest_raw.get(speaker, 0.0) >= minimum_total
    }
    if rescued_speakers:
        rescued_turns: list[dict[str, Any]] = []
        for winner in turns:
            rescue_intervals = [
                {
                    "speaker": candidate["speaker"],
                    "start": max(winner["start"], candidate["start"]),
                    "end": min(winner["end"], candidate["end"]),
                    "onset": candidate["start"],
                    "original_duration": candidate["original_duration"],
                }
                for candidate in candidates
                if candidate["speaker"] in rescued_speakers
                and candidate["start"] < winner["end"]
                and candidate["end"] > winner["start"]
            ]
            if not rescue_intervals:
                rescued_turns.append(dict(winner))
                continue

            boundaries = sorted({
                value
                for interval in rescue_intervals
                for value in (interval["start"], interval["end"])
            } | {winner["start"], winner["end"]})
            fragments: list[dict[str, Any]] = []
            for start, end in zip(boundaries, boundaries[1:]):
                if end <= start:
                    continue
                active = [
                    interval
                    for interval in rescue_intervals
                    if interval["start"] <= start
                    and interval["end"] > start
                ]
                latest = max(
                    active,
                    key=lambda interval: (
                        interval["onset"],
                        interval["original_duration"],
                        -interval["speaker"],
                    ),
                ) if active else None
                speaker = (
                    latest["speaker"]
                    if latest is not None
                    else winner["speaker"]
                )
                if fragments and fragments[-1]["speaker"] == speaker:
                    fragments[-1]["end"] = end
                else:
                    fragments.append({
                        "speaker": speaker,
                        "start": start,
                        "end": end,
                    })

            # Do not create a tiny retranscription call just to resume the
            # original winner at the end of a rescued turn.
            appeared_speakers = {
                fragment["speaker"]
                for fragment in fragments[:-1]
            }
            if (
                len(fragments) >= 2
                and fragments[-2]["speaker"] in rescued_speakers
                and fragments[-1]["speaker"] in appeared_speakers
                and fragments[-1]["end"] - fragments[-1]["start"] < 0.7
            ):
                fragments[-2]["end"] = fragments[-1]["end"]
                fragments.pop()

            for fragment in fragments:
                if (
                    rescued_turns
                    and rescued_turns[-1]["speaker"] == fragment["speaker"]
                    and fragment["start"] - rescued_turns[-1]["end"] <= 0.0
                ):
                    rescued_turns[-1]["end"] = fragment["end"]
                else:
                    rescued_turns.append(fragment)
        turns = rescued_turns

    totals: dict[int, float] = {}
    for turn in turns:
        totals[turn["speaker"]] = totals.get(turn["speaker"], 0.0) + turn["end"] - turn["start"]
    dominant = max(totals, key=totals.get)
    kept = {speaker for speaker, total in totals.items() if total >= minimum_total}
    # Rescue eligibility is intentionally based on the stronger raw evidence;
    # onset partitioning can assign less than minimum_total to a real speaker.
    kept.update(rescued_speakers)
    kept.add(dominant)
    for index, turn in enumerate(turns):
        if turn["speaker"] in kept:
            continue
        previous = turns[index - 1]["speaker"] if index > 0 and turns[index - 1]["speaker"] in kept else None
        following = (
            turns[index + 1]["speaker"]
            if index + 1 < len(turns) and turns[index + 1]["speaker"] in kept
            else None
        )
        turn["speaker"] = previous or following or dominant

    merged: list[dict[str, Any]] = []
    for turn in turns:
        if merged and merged[-1]["speaker"] == turn["speaker"] and turn["start"] - merged[-1]["end"] <= 0.8:
            merged[-1]["end"] = max(merged[-1]["end"], turn["end"])
        else:
            merged.append(turn)
    return [
        {"speaker": turn["speaker"], "start": turn["start"], "end": turn["end"]}
        for turn in merged
    ]


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as source:
        return source.getnframes() / float(max(1, source.getframerate()))


def dominant_speaker_for_range(
    raw_segments: list[Any],
    start: float,
    end: float,
) -> int | None:
    durations: dict[int, float] = {}
    for segment in raw_segments:
        speaker = normalize_speaker(getattr(segment, "speaker", None))
        if speaker is None:
            continue
        overlap = max(
            0.0,
            min(end, float(getattr(segment, "end", 0.0)))
            - max(start, float(getattr(segment, "start", 0.0))),
        )
        if overlap > 0:
            durations[speaker] = durations.get(speaker, 0.0) + overlap
    return max(
        durations,
        key=lambda speaker: (durations[speaker], -speaker),
    ) if durations else None


def conservative_speaker_turns_for_range(
    raw_segments: list[Any],
    start: float,
    end: float,
) -> list[dict[str, Any]] | None:
    """Return only simple, sustained two-speaker activity inside one block.

    Streaming diarization can contain overlaps, repeated spans, and brief false
    speakers. Reuse the validated turn merger, then accept only high-confidence
    A-B or A-B-A shapes where both speakers have enough summed activity to be
    represented without guessing at a dense conversation.
    """
    block_duration = end - start
    if block_duration <= 0.0:
        return None

    local_segments: list[Any] = []
    for raw in raw_segments:
        candidate_start = max(start, float(getattr(raw, "start", 0.0)))
        candidate_end = min(end, float(getattr(raw, "end", 0.0)))
        if candidate_end <= candidate_start:
            continue
        local_segments.append(SimpleNamespace(
            speaker=getattr(raw, "speaker", None),
            start=candidate_start - start,
            end=candidate_end - start,
        ))
    turns = [
        {
            **turn,
            "start": float(turn["start"]) + start,
            "end": float(turn["end"]) + start,
        }
        for turn in merge_turns(local_segments, block_duration)
    ]

    if len(turns) not in {2, 3}:
        return None
    speakers = {int(turn["speaker"]) for turn in turns}
    if len(speakers) != 2:
        return None
    minimum_speaker_duration = max(2.0, block_duration * 0.10)
    if any(
        sum(
            float(turn["end"]) - float(turn["start"])
            for turn in turns
            if int(turn["speaker"]) == speaker
        ) + 1e-9 < minimum_speaker_duration
        for speaker in speakers
    ):
        return None
    return turns


def allocate_text_to_speaker_turns(
    text: str,
    turns: list[dict[str, Any]],
    start: float,
    end: float,
) -> list[dict[str, Any]] | None:
    """Assign canonical tokens by speech duration, then label whole sentences."""
    tokens = str(text or "").split()
    if not tokens or not turns:
        return None

    durations = [
        max(0.0, float(turn["end"]) - float(turn["start"]))
        for turn in turns
    ]
    total_duration = sum(durations)
    if total_duration <= 0.0:
        return None
    cumulative_durations: list[float] = []
    cumulative = 0.0
    for turn_duration in durations:
        cumulative += turn_duration
        cumulative_durations.append(cumulative)

    word_labels: list[int] = []
    for index in range(len(tokens)):
        target = (index + 0.5) * total_duration / len(tokens)
        selected = next(
            (
                offset
                for offset, boundary in enumerate(cumulative_durations)
                if target <= boundary
            ),
            len(turns) - 1,
        )
        word_labels.append(int(turns[selected]["speaker"]))

    sentence_labels = list(word_labels)
    sentence_start = 0
    for index, token in enumerate(tokens):
        if (
            not re.search(
                r"[.!?\u2026\u3002\uff01\uff1f]+[\"'\u2019\u201d\u3009\u300b\uff09)\]}]*$",
                token,
            )
            and index + 1 < len(tokens)
        ):
            continue
        group = word_labels[sentence_start:index + 1]
        ordered_speakers = list(dict.fromkeys(group))
        sentence_speaker = max(
            ordered_speakers,
            key=lambda speaker: (
                group.count(speaker),
                -group.index(speaker),
            ),
        )
        sentence_labels[sentence_start:index + 1] = [sentence_speaker] * len(group)
        sentence_start = index + 1

    label_runs: list[tuple[int, int, int]] = []
    for index, speaker in enumerate(sentence_labels):
        if label_runs and label_runs[-1][2] == speaker:
            run_start, _, run_speaker = label_runs[-1]
            label_runs[-1] = (run_start, index + 1, run_speaker)
        else:
            label_runs.append((index, index + 1, speaker))

    def token_boundary_time(token_index: int) -> float:
        if token_index <= 0:
            return start
        if token_index >= len(tokens):
            return end
        target = token_index * total_duration / len(tokens)
        elapsed = 0.0
        for turn_index, (turn, turn_duration) in enumerate(zip(turns, durations)):
            next_elapsed = elapsed + turn_duration
            if target < next_elapsed - 1e-9:
                fraction = (target - elapsed) / max(turn_duration, 1e-9)
                return float(turn["start"]) + fraction * turn_duration
            if abs(target - next_elapsed) <= 1e-9:
                if turn_index + 1 < len(turns):
                    return (
                        float(turn["end"])
                        + float(turns[turn_index + 1]["start"])
                    ) / 2.0
                return float(turn["end"])
            elapsed = next_elapsed
        return end

    allocated: list[dict[str, Any]] = []
    previous_end = start
    for run_index, (first, last, speaker) in enumerate(label_runs):
        segment_end = (
            end
            if run_index + 1 == len(label_runs)
            else min(end, max(previous_end, token_boundary_time(last)))
        )
        allocated.append({
            "speaker": speaker,
            "text": " ".join(tokens[first:last]),
            "start": previous_end,
            "end": segment_end,
        })
        previous_end = segment_end
    if any(
        segment["end"] < segment["start"]
        for segment in allocated
    ) or join_transcript(*(segment["text"] for segment in allocated)) != text:
        return None
    return allocated


def split_long_block_by_speaker(
    text: str,
    raw_segments: list[Any],
    start: float,
    end: float,
) -> list[dict[str, Any]] | None:
    turns = conservative_speaker_turns_for_range(raw_segments, start, end)
    if turns is None:
        return None
    return allocate_text_to_speaker_turns(text, turns, start, end)


def build_rolling_speaker_segments(
    refined_blocks: list[dict[str, Any]],
    raw_segments: list[Any],
    duration: float,
) -> list[dict[str, Any]]:
    """Build a bounded-memory long-meeting result from live model output."""
    prepared: list[dict[str, Any]] = []
    previous_speaker: int | None = None
    for block in refined_blocks:
        text = str(block.get("text", "") or "").strip()
        if not text:
            continue
        start = max(0.0, float(block.get("start", 0.0)))
        end = min(duration, max(start, float(block.get("end", start))))
        allocated = split_long_block_by_speaker(
            text,
            raw_segments,
            start,
            end,
        )
        if allocated is not None:
            prepared.extend(allocated)
            previous_speaker = int(allocated[-1]["speaker"])
            continue
        speaker = dominant_speaker_for_range(raw_segments, start, end) or previous_speaker
        prepared.append({"speaker": speaker, "text": text, "start": start, "end": end})
        previous_speaker = speaker

    next_speaker: int | None = None
    for block in reversed(prepared):
        if block["speaker"] is None:
            block["speaker"] = next_speaker
        else:
            next_speaker = block["speaker"]

    merged: list[dict[str, Any]] = []
    for block in prepared:
        if merged and merged[-1]["speaker"] == block["speaker"]:
            merged[-1]["text"] = join_transcript(merged[-1]["text"], block["text"])
            merged[-1]["end"] = block["end"]
        else:
            merged.append(block)
    return merged or [{"speaker": None, "text": "", "start": 0.0, "end": duration}]


def alphanumeric_length(text: str) -> int:
    """Count transcript content while ignoring spacing and punctuation."""
    return sum(character.isalnum() for character in str(text or ""))


def has_sufficient_retranscription(candidate: str, fallback_text: str) -> bool:
    expected_length = alphanumeric_length(fallback_text)
    if expected_length == 0:
        return True
    candidate_length = alphanumeric_length(candidate)
    return (
        candidate_length * 100
        >= expected_length * MIN_RETRANSCRIPTION_CONTENT_PERCENT
    )


def build_lossless_fallback_segments(
    fallback_text: str,
    duration: float,
    refined_blocks: list[dict[str, Any]] | None,
    raw_segments: list[Any] | None,
) -> list[dict[str, Any]]:
    """Keep speaker labels only when rolling blocks reproduce the fallback."""
    fallback = [{
        "speaker": None,
        "text": fallback_text,
        "start": 0.0,
        "end": duration,
    }]
    if not refined_blocks:
        return fallback

    reconstructed = join_transcript(*(
        str(block.get("text", "") or "")
        for block in refined_blocks
    ))
    if reconstructed != fallback_text:
        return fallback

    rolling = build_rolling_speaker_segments(
        refined_blocks,
        raw_segments or [],
        duration,
    )
    rolling_text = join_transcript(*(
        str(segment.get("text", "") or "")
        for segment in rolling
    ))
    return rolling if rolling_text == fallback_text else fallback


def alignment_token(value: str) -> str:
    """Normalize one whitespace token for conservative ASR alignment."""
    return "".join(
        character
        for character in unicodedata.normalize("NFKC", value).casefold()
        if character.isalnum()
    )


def align_transcript_tokens(
    canonical: list[str],
    hypothesis: list[str],
) -> list[tuple[str, int, int, int, int]] | None:
    """Find a global, ordered edit alignment, with bounded time and memory.

    Greedy longest-block matching can align the first occurrence of a repeated
    sentence to its later, more accurately transcribed occurrence and erase
    entire earlier speaker turns. Minimize edits over the complete sequence
    instead. Keep one cost row and one byte per backtracking cell.
    """
    if canonical == hypothesis:
        return [("equal", 0, len(canonical), 0, len(hypothesis))]
    if (len(canonical) + 1) * (len(hypothesis) + 1) > MAX_SPEAKER_ALIGNMENT_CELLS:
        return None

    directions = [bytearray(len(hypothesis) + 1) for _ in range(len(canonical) + 1)]
    costs = list(range(len(hypothesis) + 1))
    for i, token in enumerate(canonical, 1):
        previous = costs
        costs = [i] + [0] * len(hypothesis)
        for j, candidate in enumerate(hypothesis, 1):
            diagonal = previous[j - 1] + (token != candidate)
            deleted = previous[j] + 1
            inserted = costs[j - 1] + 1
            best = min(diagonal, deleted, inserted)
            costs[j] = best
            # Prefer the diagonal for stable, deterministic ties.
            directions[i][j] = 0 if best == diagonal else (1 if best == deleted else 2)

    i, j = len(canonical), len(hypothesis)
    edits: list[tuple[str, int, int, int, int]] = []
    while i or j:
        if i and j and directions[i][j] == 0:
            tag = "equal" if canonical[i - 1] == hypothesis[j - 1] else "replace"
            edits.append((tag, i - 1, i, j - 1, j))
            i -= 1
            j -= 1
        elif i and (not j or directions[i][j] == 1):
            edits.append(("delete", i - 1, i, j, j))
            i -= 1
        else:
            edits.append(("insert", i, i, j - 1, j))
            j -= 1

    opcodes: list[tuple[str, int, int, int, int]] = []
    for tag, a_start, a_end, b_start, b_end in reversed(edits):
        if opcodes and opcodes[-1][0] == tag:
            _, a_start, _, b_start, _ = opcodes.pop()
        opcodes.append((tag, a_start, a_end, b_start, b_end))
    return opcodes


def align_canonical_text_to_speakers(
    canonical_text: str,
    speaker_segments: list[dict[str, Any]],
) -> list[dict[str, Any]] | None:
    """Use per-turn ASR only as anchors while preserving canonical text.

    Re-transcribing padded speaker turns can add, omit, or repeat words. Those
    hypotheses are useful for locating speaker changes, but the rolling
    accuracy transcript remains the document's source of truth.
    """
    canonical_tokens = str(canonical_text or "").split()
    if not canonical_tokens or not speaker_segments:
        return None

    canonical_search = [
        (index, normalized)
        for index, token in enumerate(canonical_tokens)
        if (normalized := alignment_token(token))
    ]
    speaker_search: list[tuple[int, str]] = []
    for segment_index, segment in enumerate(speaker_segments):
        for token in str(segment.get("text", "") or "").split():
            normalized = alignment_token(token)
            if normalized:
                speaker_search.append((segment_index, normalized))
    if not canonical_search or not speaker_search:
        return None

    opcodes = align_transcript_tokens(
        [token for _, token in canonical_search],
        [token for _, token in speaker_search],
    )
    if opcodes is None:
        return None
    matching_tokens = sum(end - start for tag, start, end, _, _ in opcodes if tag == "equal")
    required_matches = 1 if len(canonical_search) <= 4 else max(
        2,
        (len(canonical_search) + 4) // 5,
    )
    if matching_tokens < required_matches:
        return None

    assignments: list[int | None] = [None] * len(canonical_tokens)
    inserted_positions: dict[int, set[int]] = {}
    inserted_boundaries: dict[int, set[int]] = {}
    for tag, canonical_start, canonical_end, speaker_start, speaker_end in opcodes:
        canonical_count = canonical_end - canonical_start
        speaker_count = speaker_end - speaker_start
        if tag == "equal":
            for offset in range(canonical_count):
                canonical_index = canonical_search[canonical_start + offset][0]
                assignments[canonical_index] = speaker_search[speaker_start + offset][0]
        elif tag == "replace" and canonical_count and speaker_count:
            for offset in range(canonical_count):
                mapped_offset = min(
                    speaker_count - 1,
                    int((offset + 0.5) * speaker_count / canonical_count),
                )
                canonical_index = canonical_search[canonical_start + offset][0]
                assignments[canonical_index] = speaker_search[speaker_start + mapped_offset][0]
        elif tag == "insert" and 0 < canonical_start < len(canonical_search):
            for speaker_position in range(speaker_start, speaker_end):
                segment_index = speaker_search[speaker_position][0]
                inserted_positions.setdefault(segment_index, set()).add(speaker_position)
                inserted_boundaries.setdefault(segment_index, set()).add(canonical_start)

    assigned_indices = [index for index, assignment in enumerate(assignments) if assignment is not None]
    if not assigned_indices:
        return None

    # A short accepted turn can be transcribed as an extra filler word that is
    # absent from the canonical transcript. Edit alignment correctly marks
    # that hypothesis as an insertion, but dropping it can also remove a real
    # speaker completely. Recover only an interior, insertion-only turn that
    # is bracketed by already anchored source turns. Moving one neighboring
    # canonical token preserves order and exact text; requiring the donor turn
    # to retain another token prevents one recovered speaker from erasing one
    # that was already represented. The interior/0.7s/insert-only conditions
    # deliberately avoid promoting arbitrary edge noise or weak fragments.
    positions_by_segment: dict[int, set[int]] = {}
    for speaker_position, (segment_index, _) in enumerate(speaker_search):
        positions_by_segment.setdefault(segment_index, set()).add(speaker_position)
    assignment_counts: dict[int, int] = {}
    for assignment in assignments:
        if assignment is not None:
            assignment_counts[assignment] = assignment_counts.get(assignment, 0) + 1
    represented_speakers = {
        speaker_segments[segment_index].get("speaker")
        for segment_index in assignment_counts
    }
    for segment_index, segment in enumerate(speaker_segments):
        speaker = segment.get("speaker")
        if speaker is None or speaker in represented_speakers:
            continue
        try:
            segment_duration = float(segment.get("end")) - float(segment.get("start"))
        except (TypeError, ValueError):
            continue
        positions = positions_by_segment.get(segment_index, set())
        boundaries = inserted_boundaries.get(segment_index, set())
        if (
            segment_duration < 0.7
            or not positions
            or positions != inserted_positions.get(segment_index, set())
            or len(boundaries) != 1
        ):
            continue
        boundary = next(iter(boundaries))
        previous_index = canonical_search[boundary - 1][0]
        following_index = canonical_search[boundary][0]
        previous_assignment = assignments[previous_index]
        following_assignment = assignments[following_index]
        if (
            previous_assignment is None
            or following_assignment is None
            or not previous_assignment < segment_index < following_assignment
        ):
            continue
        for canonical_index in (following_index, previous_index):
            donor = assignments[canonical_index]
            if donor is None or assignment_counts.get(donor, 0) < 2:
                continue
            assignments[canonical_index] = segment_index
            assignment_counts[donor] -= 1
            assignment_counts[segment_index] = 1
            represented_speakers.add(speaker)
            break

    previous_by_index: list[int | None] = []
    previous: int | None = None
    for index, assignment in enumerate(assignments):
        previous_by_index.append(previous)
        if assignment is not None:
            previous = index
    following_by_index: list[int | None] = [None] * len(assignments)
    following: int | None = None
    for index in range(len(assignments) - 1, -1, -1):
        following_by_index[index] = following
        if assignments[index] is not None:
            following = index
    for index, assignment in enumerate(assignments):
        if assignment is not None:
            continue
        previous = previous_by_index[index]
        following = following_by_index[index]
        if previous is None:
            assignments[index] = assignments[following] if following is not None else None
        elif following is None:
            assignments[index] = assignments[previous]
        elif index - previous <= following - index:
            assignments[index] = assignments[previous]
        else:
            assignments[index] = assignments[following]
    if any(assignment is None for assignment in assignments):
        return None

    aligned: list[dict[str, Any]] = []
    group_start = 0
    for index in range(1, len(canonical_tokens) + 1):
        if index < len(canonical_tokens):
            current = speaker_segments[int(assignments[index])]
            previous = speaker_segments[int(assignments[index - 1])]
            if current.get("speaker") == previous.get("speaker"):
                continue
        first_segment = speaker_segments[int(assignments[group_start])]
        last_segment = speaker_segments[int(assignments[index - 1])]
        aligned.append({
            "speaker": first_segment.get("speaker"),
            "text": " ".join(canonical_tokens[group_start:index]),
            "start": first_segment.get("start"),
            "end": last_segment.get("end"),
        })
        group_start = index

    reconstructed = " ".join(str(segment["text"]) for segment in aligned)
    expected = " ".join(canonical_tokens)
    return aligned if reconstructed == expected else None


def read_wav(path: Path):
    import numpy as np

    with wave.open(str(path), "rb") as source:
        channels = source.getnchannels()
        sample_rate = source.getframerate()
        width = source.getsampwidth()
        frames = source.readframes(source.getnframes())
    if width != 2:
        raise RuntimeError("복구 오디오는 16-bit PCM이어야 합니다")
    audio = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    return audio, sample_rate


def run_mock(args: argparse.Namespace) -> None:
    emit("download", progress=1.0, message="테스트 전사 엔진 준비 완료")
    if os.environ.get("KUKU_MEETING_ASR_RECOVERY") == "1":
        time.sleep(float(os.environ.get("KUKU_MEETING_ASR_RECOVERY_READY_DELAY", "0") or 0))
    emit("ready")
    chunk_index = 0
    stable_parts: list[str] = []
    examples = [
        "미팅 노트 전사를 시작했습니다.",
        "지금 들리는 내용이 문서에 바로 기록됩니다.",
        "종료하면 화자별 문장으로 정리합니다.",
    ]
    crash_after = int(os.environ.get("KUKU_MEETING_ASR_CRASH_AFTER_CHUNKS", "0") or 0)
    crash_on_finish = os.environ.get("KUKU_MEETING_ASR_CRASH_ON_FINISH") == "1"
    recovery_worker = os.environ.get("KUKU_MEETING_ASR_RECOVERY") == "1"
    crash_during_recovery = os.environ.get("KUKU_MEETING_ASR_CRASH_DURING_RECOVERY") == "1"
    while True:
        frame = read_frame()
        if frame is None:
            return
        kind, _ = frame
        if kind == 1:
            text = examples[chunk_index % len(examples)]
            stable_parts.append(text)
            chunk_index += 1
            emit(
                "transcript",
                stableText=" ".join(stable_parts),
                unstableText="",
                speakerId=((chunk_index - 1) % 2) + 1,
            )
            if (
                crash_after > 0
                and chunk_index >= crash_after
                and (not recovery_worker or crash_during_recovery)
            ):
                os._exit(91)
        elif kind == 2:
            if crash_on_finish and (not recovery_worker or crash_during_recovery):
                os._exit(92)
            emit("finalizing", progress=0.5, message="테스트 화자를 정리하고 있습니다")
            time.sleep(0.15)
            segments = [
                {"speaker": (index % 2) + 1, "text": text, "start": index * 2.0, "end": (index + 1) * 2.0}
                for index, text in enumerate(stable_parts)
            ]
            emit("final", text=" ".join(stable_parts), segments=segments)
            return
        elif kind == 3:
            return


def run_real(args: argparse.Namespace) -> None:
    import numpy as np
    import mlx.core as mx
    from mlx_qwen3_asr import Session
    from mlx_audio.vad import load as load_diarization

    # MLX otherwise retains several gigabytes of transient Metal allocations.
    # Bound the cache so a 16 GB Mac stays responsive during long meetings.
    mx.set_cache_limit(512 * 1024 * 1024)

    configure_streaming_join_rules()
    root = Path(args.model_dir)
    asr_path = prepare_model(ASR_REPO, root / "qwen3-asr-0.6b-8bit", 0.0, 0.81, "로컬 전사 모델을 준비하고 있습니다")
    diar_path = prepare_model(DIAR_REPO, root / "sortformer-v2.1-fp16", 0.81, 1.0, "화자 구분 모델을 준비하고 있습니다")

    emit("loading", message="전사 모델을 메모리에 올리고 있습니다")
    session = Session(model=str(asr_path))
    def new_streaming_state():
        return session.init_streaming(
            context=MEETING_CONTEXT,
            unfixed_chunk_num=1,
            unfixed_token_num=2,
            chunk_size_sec=2.0,
            max_context_sec=30.0,
            endpointing_mode="energy",
            finalization_mode="accuracy",
        )

    asr_state = new_streaming_state()
    emit("loading", message="화자 구분 모델을 메모리에 올리고 있습니다")
    diar_model = load_diarization(str(diar_path))
    diar_state = diar_model.init_streaming_state()
    emit("ready")

    last_stable = ""
    last_text = ""
    refined_parts: list[str] = []
    refined_blocks: list[dict[str, Any]] = []
    live_diar_segments: list[Any] = []
    block_diar_segments: list[Any] = []
    block_chunks: list[Any] = []
    block_samples = 0
    processed_samples = 0
    refine_samples = int(16000 * ROLLING_REFINE_SECONDS)
    while True:
        frame = read_frame()
        if frame is None:
            return
        kind, payload = frame
        if kind == 3:
            return
        if kind == 1:
            if not payload:
                continue
            pcm = np.frombuffer(payload, dtype="<f4").astype(np.float32, copy=False)
            block_chunks.append(pcm)
            block_samples += len(pcm)
            processed_samples += len(pcm)
            asr_state = session.feed_audio(pcm, asr_state)
            speaker = None
            try:
                diar_result, diar_state = diar_model.feed(
                    pcm,
                    diar_state,
                    sample_rate=16000,
                    threshold=DIARIZATION_THRESHOLD,
                    min_duration=0.64,
                    merge_gap=0.24,
                )
                new_diar_segments = list(getattr(diar_result, "segments", []) or [])
                live_diar_segments.extend(new_diar_segments)
                block_diar_segments.extend(new_diar_segments)
                speaker = choose_live_speaker(diar_result)
            except Exception:
                speaker = None
            stream_language = getattr(asr_state, "language", None)
            stream_stable = sanitize_stream_text(
                str(getattr(asr_state, "stable_text", "") or ""),
                stream_language,
            )
            stream_text = sanitize_stream_text(
                str(getattr(asr_state, "text", "") or ""),
                stream_language,
            )
            if block_samples >= refine_samples:
                block_audio = np.concatenate(block_chunks)
                block_end = processed_samples / 16000.0
                block_start = max(0.0, block_end - len(block_audio) / 16000.0)
                activity = speech_activity_ratio(block_diar_segments, block_start, block_end)
                refined, refined_language = transcribe_meeting_audio(
                    session,
                    block_audio,
                    16000,
                    speech_activity=activity,
                )
                refined = sanitize_stream_text(refined, refined_language)
                suppressed = should_suppress_low_speech_hallucination(
                    refined_language,
                    activity,
                    refined,
                )
                block_text = "" if suppressed else refined or stream_text
                # Accuracy blocks are contiguous and do not share audio.
                # Preserve intentional repetitions such as "네. 네".
                refined_parts.append(block_text)
                refined_blocks.append({
                    "start": block_start,
                    "end": block_end,
                    "text": block_text,
                })
                block_chunks = []
                block_samples = 0
                block_diar_segments = []
                asr_state = new_streaming_state()
                stream_stable = ""
                stream_text = ""
            prefix = join_transcript(*refined_parts)
            stable = join_transcript(prefix, stream_stable)
            text = join_transcript(prefix, stream_text)
            unstable = text[len(stable):].lstrip() if text.startswith(stable) else text
            if stable != last_stable or text != last_text:
                emit("transcript", stableText=stable, unstableText=unstable, speakerId=speaker)
                last_stable, last_text = stable, text
        elif kind == 2:
            stream_language = getattr(asr_state, "language", None)
            pre_finalize_text = sanitize_stream_text(
                str(getattr(asr_state, "text", "") or ""),
                stream_language,
            )
            # mlx-qwen3-asr 0.3.5 falls back to the default fp16 repo when its
            # internal tail-refine receives a preloaded model object. Run the
            # same accuracy pass through this Session so the local tokenizer
            # and weights are reused and no second model is downloaded.
            stream_final_text = pre_finalize_text
            # An exact 20-second boundary has already been refined and resets
            # the streaming state. Do not finalize an empty state in that case.
            if block_chunks:
                asr_state.enable_tail_refine = False
                asr_state = session.finish_streaming(asr_state)
                stream_final_text = sanitize_stream_text(
                    str(getattr(asr_state, "text", "") or ""),
                    getattr(asr_state, "language", None),
                )
            if block_chunks:
                block_audio = np.concatenate(block_chunks)
                block_end = processed_samples / 16000.0
                block_start = max(0.0, block_end - len(block_audio) / 16000.0)
                activity = speech_activity_ratio(block_diar_segments, block_start, block_end)
                refined_text, refined_language = transcribe_meeting_audio(
                    session,
                    block_audio,
                    16000,
                    speech_activity=activity,
                )
                refined_text = sanitize_stream_text(refined_text, refined_language)
                suppressed = should_suppress_low_speech_hallucination(
                    refined_language,
                    activity,
                    refined_text,
                )
                block_text = "" if suppressed else refined_text or stream_final_text or pre_finalize_text
                refined_parts.append(block_text)
                refined_blocks.append({
                    "start": block_start,
                    "end": block_end,
                    "text": block_text,
                })
            final_text = join_transcript(*refined_parts)
            emit("transcript", stableText=final_text, unstableText="", speakerId=None)
            segments = finalize_speakers(
                Path(args.audio_path),
                session,
                diar_model,
                final_text,
                live_diar_segments=live_diar_segments,
                refined_blocks=refined_blocks,
                duration_hint=processed_samples / 16000.0,
            )
            emit("final", text=final_text, segments=segments)
            return


def finalize_speakers(
    audio_path: Path,
    session: Any,
    diar_model: Any,
    fallback_text: str,
    *,
    live_diar_segments: list[Any] | None = None,
    refined_blocks: list[dict[str, Any]] | None = None,
    duration_hint: float | None = None,
) -> list[dict[str, Any]]:
    import numpy as np

    if not audio_path.exists():
        return [{"speaker": None, "text": fallback_text, "start": None, "end": None}]
    duration = duration_hint if duration_hint is not None else wav_duration(audio_path)
    if duration >= FULL_FILE_DIARIZATION_LIMIT_SECONDS:
        emit("finalizing", progress=0.92, message="장시간 미팅의 화자 구간을 정리하고 있습니다")
        return build_lossless_fallback_segments(
            fallback_text,
            duration,
            refined_blocks,
            live_diar_segments,
        )
    audio, sample_rate = read_wav(audio_path)
    duration = len(audio) / float(sample_rate)
    emit("finalizing", progress=0.08, message="전체 오디오에서 화자 구간을 정리하고 있습니다")

    # mlx-audio 0.4.4 trims leading/trailing silence in generate(). It adds
    # the leading-silence offset to segments, but returns speaker_probs on the
    # trimmed clock. Reproduce the pinned model's preprocessing on the exact
    # same loaded waveform so probabilities can be indexed on the original
    # audio clock. If this private contract ever changes, keep the segments
    # and deliberately fall back to duration-based overlap resolution instead
    # of attaching probabilities to the wrong times.
    generation_audio: Any = str(audio_path)
    generation_sample_rate: int | None = None
    probability_start_seconds: float | None = None
    probability_frame_seconds: float | None = None
    try:
        model_audio, model_sample_rate = diar_model._load_audio(audio, sample_rate)
        trimmed_audio, trim_offset = diar_model._trim_silence(
            model_audio,
            model_sample_rate,
        )
        model_shape = tuple(int(value) for value in model_audio.shape)
        trimmed_shape = tuple(int(value) for value in trimmed_audio.shape)
        processor = diar_model._processor_config
        fc_config = diar_model.config.fc_encoder_config
        model_sample_rate = int(model_sample_rate)
        trim_offset = int(trim_offset)
        hop_length = float(processor.hop_length)
        subsampling_factor = float(fc_config.subsampling_factor)
        frame_seconds = (
            hop_length * subsampling_factor / float(model_sample_rate)
        )
        if (
            len(model_shape) != 1
            or len(trimmed_shape) != 1
            or model_shape[0] <= 0
            or trimmed_shape[0] <= 0
            or model_sample_rate <= 0
            or trim_offset < 0
            or trim_offset + trimmed_shape[0] > model_shape[0]
            or not math.isfinite(frame_seconds)
            or frame_seconds <= 0.0
        ):
            raise ValueError("unsupported diarizer preprocessing metadata")
        generation_audio = model_audio
        generation_sample_rate = model_sample_rate
        probability_start_seconds = trim_offset / float(model_sample_rate)
        probability_frame_seconds = frame_seconds
    except Exception:
        # The private preprocessing API is pinned by requirements.lock, but a
        # future package change must disable probability scoring safely.
        probability_start_seconds = None
        probability_frame_seconds = None

    generation_options = {
        "threshold": DIARIZATION_THRESHOLD,
        "min_duration": 0.7,
        "merge_gap": 0.24,
    }
    if generation_sample_rate is not None:
        generation_options["sample_rate"] = generation_sample_rate
    output = diar_model.generate(generation_audio, **generation_options)
    raw_segments = list(getattr(output, "segments", []) or [])

    speaker_timeline: SpeakerProbabilityTimeline | None = None
    try:
        speaker_probs = getattr(output, "speaker_probs", None)
        probability_shape = tuple(int(value) for value in speaker_probs.shape)
        if (
            probability_start_seconds is None
            or probability_frame_seconds is None
            or len(probability_shape) != 2
            or probability_shape[0] <= 0
            or probability_shape[1] <= 0
        ):
            raise ValueError("unsupported speaker probability shape")
        speaker_timeline = SpeakerProbabilityTimeline(
            values=speaker_probs,
            start_seconds=probability_start_seconds,
            frame_seconds=probability_frame_seconds,
        )
    except Exception:
        speaker_timeline = None

    def lossless_fallback() -> list[dict[str, Any]]:
        return build_lossless_fallback_segments(
            fallback_text,
            duration,
            refined_blocks,
            raw_segments or live_diar_segments,
        )

    turns = merge_turns(
        raw_segments,
        duration,
        speaker_timeline,
    )
    if not turns:
        return lossless_fallback()

    # Splitting a single-speaker recording into diarization turns lowers ASR
    # accuracy and can clip Korean syllables at each boundary. The rolling
    # accuracy text is already canonical, so only attach the speaker label.
    speakers = {int(turn["speaker"]) for turn in turns}
    if len(speakers) == 1:
        return [{
            "speaker": next(iter(speakers)),
            "text": fallback_text,
            "start": 0.0,
            "end": duration,
        }]

    final_segments: list[dict[str, Any]] = []
    for index, turn in enumerate(turns):
        start_sample = max(0, int((turn["start"] - 0.15) * sample_rate))
        end_sample = min(len(audio), int((turn["end"] + 0.15) * sample_rate))
        if end_sample <= start_sample:
            return lossless_fallback()
        emit(
            "finalizing",
            progress=0.12 + 0.86 * ((index + 1) / max(1, len(turns))),
            message=f"화자별 문장을 정리하고 있습니다 · {index + 1}/{len(turns)}",
        )
        try:
            text = transcribe_audio_windowed(
                session,
                np.asarray(audio[start_sample:end_sample]),
                sample_rate,
            )
        except Exception:
            text = ""
        if not text:
            return lossless_fallback()
        final_segments.append({
            "speaker": turn["speaker"],
            "text": text,
            "start": round(turn["start"], 3),
            "end": round(turn["end"], 3),
        })

    final_text = join_transcript(*(
        str(segment["text"])
        for segment in final_segments
    ))
    if not has_sufficient_retranscription(final_text, fallback_text):
        return lossless_fallback()
    return align_canonical_text_to_speakers(fallback_text, final_segments) or lossless_fallback()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--audio-path", required=True)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--mock", action="store_true")
    args = parser.parse_args()
    try:
        if args.mock:
            run_mock(args)
        else:
            run_real(args)
    except Exception as error:
        emit("error", code="worker_exception", message=f"로컬 전사 엔진 오류: {error}")
        raise


if __name__ == "__main__":
    main()
