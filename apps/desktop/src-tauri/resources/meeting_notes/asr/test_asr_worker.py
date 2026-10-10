import unittest
import sys
import tempfile
import wave
from pathlib import Path
from types import ModuleType
from types import SimpleNamespace
from unittest.mock import patch

from asr_worker import (
    ASR_REPO,
    DIARIZATION_THRESHOLD,
    DownloadReporter,
    FULL_FILE_DIARIZATION_LIMIT_SECONDS,
    MODEL_REVISIONS,
    SpeakerProbabilityTimeline,
    align_canonical_text_to_speakers,
    build_rolling_speaker_segments,
    contains_unexpected_script,
    configure_streaming_join_rules,
    choose_silence_boundary,
    has_excessive_repetition,
    has_sufficient_retranscription,
    finalize_speakers,
    format_unambiguous_korean_numerals,
    join_transcript,
    mean_speaker_probability,
    merge_transcript_text,
    merge_turns,
    needs_korean_retry,
    polish_meeting_transcript,
    prepare_model,
    retry_language,
    run_real,
    sanitize_stream_text,
    should_suppress_low_speech_hallucination,
    speech_activity_ratio,
    transcribe_audio_windowed,
    transcribe_meeting_audio,
)


class FakeSession:
    def __init__(self, results):
        self.results = iter(results)
        self.calls = []

    def transcribe(self, audio, **kwargs):
        self.calls.append(kwargs)
        result = next(self.results)
        if isinstance(result, BaseException):
            raise result
        return result


def probability_timeline(values, start_seconds=0.0, frame_seconds=1.0):
    return SpeakerProbabilityTimeline(
        values=values,
        start_seconds=start_seconds,
        frame_seconds=frame_seconds,
    )


class MeetingTranscriptionTests(unittest.TestCase):
    @staticmethod
    def write_silent_wav(path, duration=4.0, sample_rate=100):
        with wave.open(str(path), "wb") as target:
            target.setnchannels(1)
            target.setsampwidth(2)
            target.setframerate(sample_rate)
            target.writeframes(b"\0\0" * int(duration * sample_rate))

    @staticmethod
    def diarizer(*segments):
        class FakeDiarizer:
            def __init__(self):
                self.calls = []

            def generate(self, audio_path, **kwargs):
                self.calls.append((audio_path, kwargs))
                return SimpleNamespace(segments=list(segments), speaker_probs=None)

        return FakeDiarizer()

    def test_korean_streaming_chunks_use_word_spacing_join_rules(self):
        aliases = {"chinese", "japanese", "korean", "ko", "kr"}
        configure_streaming_join_rules(aliases)
        self.assertEqual(aliases, {"chinese", "japanese"})

    def test_stream_sanitizer_removes_foreign_script_hallucination(self):
        text = (
            "엄청 로맨틱한 곳에서 지금 인사를 해 주셨습니다. "
            "조금 추워서 들어가고 싶어요 就就死掉了 다시 얘기해요"
        )
        self.assertEqual(
            sanitize_stream_text(text, "Korean"),
            "엄청 로맨틱한 곳에서 지금 인사를 해 주셨습니다. "
            "조금 추워서 들어가고 싶어요 다시 얘기해요",
        )

    def test_stream_sanitizer_preserves_intended_language(self):
        self.assertEqual(sanitize_stream_text("这是中文内容", "Chinese"), "这是中文内容")

    def test_final_korean_block_is_tidied_without_touching_english(self):
        self.assertEqual(
            polish_meeting_transcript("어, 근데 보면은 이제 시작합니다.", "Korean"),
            "그런데 보면 이제 시작합니다.",
        )
        self.assertEqual(
            polish_meeting_transcript("Ah, but now we begin.", "English"),
            "Ah, but now we begin.",
        )

    def test_final_korean_block_formats_only_unambiguous_quantities(self):
        source = (
            "거의 이십 키로, 이십 년 삼십 년, 이천이십삼 년에, "
            "새벽 세 시에, 아침 여섯 시로, 열 시 취침, 열 시쯤, "
            "삼십 번씩, 두 시간, 사천만 원에, 열 시간씩"
        )
        self.assertEqual(
            format_unambiguous_korean_numerals(source),
            "거의 20키로, 20년 30년, 2023년에, 새벽 3시에, 아침 6시로, "
            "10시 취침, 10시쯤, 30번씩, 2시간, 4천만 원에, 10시간씩",
        )
        self.assertEqual(
            polish_meeting_transcript(source, "Korean"),
            "거의 20키로, 20년 30년, 2023년에, 새벽 3시에, 아침 6시로, "
            "10시 취침, 10시쯤, 30번씩, 2시간, 4천만 원에, 10시간씩",
        )

    def test_korean_numeral_formatting_preserves_lexical_ambiguities(self):
        lexical = (
            "이 시장은 세대마다 이 분과 두 분이 한 장면을 한번 봤다. "
            "한 시인이 한 시가 좋다고 이 시에 대해 말했고 이 년을 욕했다. "
            "두 분, 세 개, 네 장, 한 명, 일일 년은 그대로다."
        )
        self.assertEqual(format_unambiguous_korean_numerals(lexical), lexical)

    def test_korean_numeral_formatting_preserves_poetry_and_people_counters(self):
        ambiguous = (
            "나는 네 시를 좋아한다. "
            "시집에서 세 시를 골라 읽었다. "
            "열 시를 낭송했다. "
            "지원자 삼십 분을 모셨습니다. "
            "네 시간은 네가 자유롭게 써. 네 살을 에는 칼바람이 분다."
        )
        self.assertEqual(format_unambiguous_korean_numerals(ambiguous), ambiguous)

    def test_korean_numeral_formatting_keeps_explicit_clock_and_duration_context(self):
        self.assertEqual(
            format_unambiguous_korean_numerals(
                "오후 세 시 삼십 분에 회의하고 수업은 삼십 분 동안 진행했다."
            ),
            "오후 3시 30분에 회의하고 수업은 30분 동안 진행했다.",
        )
        self.assertEqual(
            format_unambiguous_korean_numerals("회의는 네 시간 동안 진행했다."),
            "회의는 4시간 동안 진행했다.",
        )
        self.assertEqual(
            format_unambiguous_korean_numerals(
                "네 여섯 시 기상입니다. 라디오에서 한 삼십 번씩 나왔다."
            ),
            "네 6시 기상입니다. 라디오에서 한 30번씩 나왔다.",
        )

    def test_korean_numeral_formatting_rejects_partial_or_malformed_cardinals(self):
        unsafe = (
            "십 만 원, 삼십 만 원, 사천 만 원, 십 억 원, "
            "이백 억 원, 천 조 원, 영십 퍼센트, "
            "십 일만 원, 사 천만 원, 삼십 이만 원, 백 이십만 원, "
            "이백 삼억 원, 천 일조 원, 백 이십 년, 이천 이십삼 년, "
            "이백 삼십 킬로, 십 오 퍼센트, 이 미터는 고장났다, "
            "네 미터는 네가 산 측정기, 10 일만 원, 3 천만 원, "
            "20 이만 원, 100 이십 년, 2020 이십삼 년, "
            "십만영 원, 일억영 원, 백영 퍼센트, 십공 미터"
        )
        self.assertEqual(format_unambiguous_korean_numerals(unsafe), unsafe)
        self.assertEqual(
            format_unambiguous_korean_numerals(
                "십만 원, 삼십만 원, 사천만 원, 십억 원, 이백억 원, 천조 원"
            ),
            "10만 원, 30만 원, 4천만 원, 10억 원, 200억 원, 1천조 원",
        )

    def test_korean_numeral_formatting_handles_safe_range_edges(self):
        self.assertEqual(
            format_unambiguous_korean_numerals(
                "백 년, 십만 원, 스물 한 살, 삼 퍼센트, 오후 한 시에"
            ),
            "100년, 10만 원, 21살, 삼 퍼센트, 오후 1시에",
        )
        self.assertEqual(
            polish_meeting_transcript("백 년, 십만 원", "English"),
            "백 년, 십만 원",
        )

    def test_speech_activity_unions_overlapping_speakers(self):
        segments = [
            SimpleNamespace(start=0.0, end=4.0),
            SimpleNamespace(start=2.0, end=6.0),
            SimpleNamespace(start=9.0, end=12.0),
        ]
        self.assertAlmostEqual(speech_activity_ratio(segments, 0.0, 10.0), 0.7)

    def test_supported_languages_with_little_speech_are_preserved(self):
        examples = [
            ("这是中文会议内容", "Chinese"),
            ("今日我哋討論下一個議題", "Cantonese"),
            ("これは日本語の会議内容です", "Japanese"),
            ("हम अगले विषय पर चर्चा करेंगे", "Hindi"),
            ("سنناقش البند التالي الآن", "Arabic"),
            ("اکنون موضوع بعدی را بررسی می‌کنیم", "Persian"),
            ("Обсудим следующий вопрос", "Russian"),
            ("Ќе разговараме за следната тема", "Macedonian"),
            ("Συζητάμε το επόμενο θέμα", "Greek"),
            ("เราจะหารือหัวข้อถัดไป", "Thai"),
            ("Wir besprechen jetzt den nächsten Punkt", "German"),
            ("Chúng ta sẽ thảo luận chủ đề tiếp theo", "Vietnamese"),
        ]
        for text, language in examples:
            with self.subTest(language=language):
                self.assertFalse(
                    should_suppress_low_speech_hallucination(
                        language,
                        0.05,
                        text,
                    )
                )
                session = FakeSession([
                    SimpleNamespace(text=text, language=language),
                ])
                self.assertEqual(
                    transcribe_meeting_audio(
                        session,
                        [0.0] * 4_000,
                        16000,
                        speech_activity=0.05,
                    ),
                    (text, language),
                )
                self.assertEqual(len(session.calls), 1)

    def test_real_low_speech_outro_language_mismatch_is_suppressed(self):
        text = (
            "哦耶，yeah，dark，the cool some hunting them turns out "
            "everything nice and warm and nice."
        )
        self.assertTrue(
            should_suppress_low_speech_hallucination("Chinese", 0.19, text)
        )
        self.assertTrue(
            should_suppress_low_speech_hallucination("Chinese", 0.19, "")
        )
        self.assertFalse(
            should_suppress_low_speech_hallucination("Chinese", 0.22, text)
        )
        session = FakeSession([
            SimpleNamespace(text=text, language="Chinese"),
        ])
        self.assertEqual(
            transcribe_meeting_audio(
                session,
                [0.0] * 4_000,
                16000,
                speech_activity=0.19,
            ),
            ("", "Chinese"),
        )
        self.assertEqual(len(session.calls), 1)

    def test_low_speech_guard_preserves_korean_english_and_unknown_behavior(self):
        cases = [
            ("Korean", "低信頼でも既存の再試行経路に渡します"),
            ("English", "低信頼でも既存の再試行経路に渡します"),
            ("unknown", "哦耶，everything nice and warm"),
            ("", "哦耶，everything nice and warm"),
        ]
        for language, text in cases:
            with self.subTest(language=language):
                self.assertFalse(
                    should_suppress_low_speech_hallucination(language, 0.05, text)
                )

    def test_unsupported_language_with_little_speech_is_suppressed(self):
        self.assertTrue(
            should_suppress_low_speech_hallucination(
                "Klingon",
                0.19,
                "unreliable noise decode",
            )
        )
        session = FakeSession([
            SimpleNamespace(text="unreliable noise decode", language="Klingon"),
        ])
        self.assertEqual(
            transcribe_meeting_audio(
                session,
                [0.0] * 4_000,
                16000,
                speech_activity=0.19,
            ),
            ("", "Klingon"),
        )
        self.assertEqual(len(session.calls), 1)

    def test_download_reporter_combines_completed_and_resumed_file_bytes(self):
        events = []
        reporter = DownloadReporter(0.1, 0.9, 1_000, "모델 다운로드")
        with patch("asr_artifacts.emit", side_effect=lambda kind, **payload: events.append((kind, payload))):
            reporter.finish_file(400)
            reporter.progress(300, force=True)
            reporter.finish_file(600)

        progress = [payload["progress"] for kind, payload in events if kind == "download"]
        self.assertEqual(progress, sorted(progress))
        self.assertAlmostEqual(progress[0], 0.42)
        self.assertAlmostEqual(progress[1], 0.66)
        self.assertAlmostEqual(progress[-1], 0.9)

    def test_prepare_model_downloads_only_missing_files_at_one_revision(self):
        fake_hub = ModuleType("huggingface_hub")
        revision = MODEL_REVISIONS[ASR_REPO]
        files = [
            SimpleNamespace(file_size=400, filename="config.json", commit_hash=revision, will_download=False),
            SimpleNamespace(file_size=600, filename="model.safetensors", commit_hash=revision, will_download=True),
        ]
        calls = []
        snapshot_calls = []
        fake_hub.snapshot_download = lambda **kwargs: snapshot_calls.append(kwargs) or files
        fake_hub.hf_hub_download = lambda **kwargs: calls.append(kwargs)

        with tempfile.TemporaryDirectory() as directory, \
             patch.dict(sys.modules, {"huggingface_hub": fake_hub}), \
             patch("asr_artifacts.invalid_model_files", return_value=["model.safetensors"]), \
             patch("asr_artifacts.verify_model", return_value=True), \
             patch("asr_artifacts.emit"):
            result = prepare_model(ASR_REPO, Path(directory), 0.0, 1.0, "모델")

        self.assertEqual(result, Path(directory))
        self.assertEqual(snapshot_calls[0]["revision"], revision)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["filename"], "model.safetensors")
        self.assertEqual(calls[0]["revision"], revision)

    def test_script_guard_accepts_korean_and_english(self):
        self.assertFalse(contains_unexpected_script("안녕하세요. Qwen meeting을 시작합니다."))

    def test_script_guard_rejects_devanagari_hallucination(self):
        self.assertTrue(contains_unexpected_script("हमारी चारपाई जहाँ रखनी है वहाँ रख दो"))
        self.assertTrue(needs_korean_retry("हमारी चारपाई", "unknown"))
        self.assertFalse(needs_korean_retry("हमारी चारपाई", "Hindi"))

    def test_repetition_guard_rejects_short_audio_hallucination(self):
        hallucination = "2022년 1월 20일 2022년 1월 20일 2022년 1월 20일 2022년 1월 20일"
        self.assertTrue(has_excessive_repetition(hallucination))
        self.assertTrue(needs_korean_retry(hallucination, "Korean"))
        self.assertFalse(has_excessive_repetition("오늘 회의에서는 첫 번째 안건과 두 번째 안건을 차례로 검토합니다"))

    def test_unknown_non_latin_decode_is_retried_as_korean(self):
        session = FakeSession([
            SimpleNamespace(text="हमारी चारपाई", language="unknown"),
            SimpleNamespace(text="지금 무슨 얘기를 하시려고요?", language="Korean"),
        ])
        text, language = transcribe_meeting_audio(session, [0.0] * 4_000, 16000)
        self.assertEqual(text, "지금 무슨 얘기를 하시려고요?")
        self.assertEqual(language, "Korean")
        self.assertEqual(session.calls[1]["language"], "Korean")

    def test_auto_detected_latin_language_is_not_forced_to_korean(self):
        session = FakeSession([
            SimpleNamespace(text="Wir beginnen jetzt mit dem Meeting.", language="German"),
        ])
        text, language = transcribe_meeting_audio(session, [0.0] * 4_000, 16000)
        self.assertEqual(text, "Wir beginnen jetzt mit dem Meeting.")
        self.assertEqual(language, "German")
        self.assertEqual(len(session.calls), 1)

    def test_auto_detected_supported_non_latin_language_is_not_retried(self):
        examples = [
            ("次の議題について話します。", "Japanese"),
            ("我们现在讨论下一个议题。", "Chinese"),
            ("हम अगले विषय पर चर्चा करेंगे।", "Hindi"),
        ]
        for expected_text, expected_language in examples:
            with self.subTest(language=expected_language):
                session = FakeSession([
                    SimpleNamespace(text=expected_text, language=expected_language),
                ])
                text, language = transcribe_meeting_audio(
                    session,
                    [0.0] * 4_000,
                    16000,
                )
                self.assertEqual(text, expected_text)
                self.assertEqual(language, expected_language)
                self.assertEqual(len(session.calls), 1)

    def test_tiny_audio_tail_is_ignored_without_invoking_model(self):
        session = FakeSession([])
        self.assertEqual(transcribe_meeting_audio(session, [0.0] * 100, 16000), ("", ""))
        self.assertEqual(session.calls, [])

    def test_truncated_decode_retries_once_with_expanded_token_budget(self):
        session = FakeSession([
            SimpleNamespace(
                text="첫 번째 내용입니다.",
                language="Korean",
                truncated=True,
            ),
            SimpleNamespace(
                text="첫 번째 내용입니다. 이어지는 내용까지 모두 기록했습니다.",
                language="Korean",
                truncated=False,
            ),
        ])

        text, language = transcribe_meeting_audio(
            session,
            [0.0] * 4_000,
            16000,
        )

        self.assertEqual(text, "첫 번째 내용입니다. 이어지는 내용까지 모두 기록했습니다.")
        self.assertEqual(language, "Korean")
        self.assertEqual(session.calls, [
            {"context": ""},
            {"context": "", "max_new_tokens": 512},
        ])

    def test_expanded_decode_failure_preserves_usable_truncated_result(self):
        original = "첫 번째 내용은 정상적으로 기록했습니다."
        session = FakeSession([
            SimpleNamespace(text=original, language="Korean", truncated=True),
            RuntimeError("temporary expanded decode failure"),
        ])

        text, language = transcribe_meeting_audio(
            session,
            [0.0] * 4_000,
            16000,
        )

        self.assertEqual(text, original)
        self.assertEqual(language, "Korean")
        self.assertEqual(session.calls, [
            {"context": ""},
            {"context": "", "max_new_tokens": 512},
        ])

    def test_unusable_expanded_decode_preserves_usable_truncated_result(self):
        original = "첫 번째 내용은 정상적으로 기록했습니다."
        expanded_results = [
            SimpleNamespace(
                text="여전히 끝나지 않은 내용",
                language="Korean",
                truncated=True,
            ),
            SimpleNamespace(text="", language="Korean", truncated=False),
        ]
        for expanded in expanded_results:
            with self.subTest(expanded=expanded):
                session = FakeSession([
                    SimpleNamespace(
                        text=original,
                        language="Korean",
                        truncated=True,
                    ),
                    expanded,
                ])

                self.assertEqual(
                    transcribe_meeting_audio(session, [0.0] * 4_000, 16000),
                    (original, "Korean"),
                )
                self.assertEqual(session.calls, [
                    {"context": ""},
                    {"context": "", "max_new_tokens": 512},
                ])

    def test_nontruncated_decode_does_not_expand_token_budget(self):
        session = FakeSession([
            SimpleNamespace(
                text="회의 내용을 정상적으로 기록했습니다.",
                language="Korean",
                truncated=False,
            ),
        ])

        self.assertEqual(
            transcribe_meeting_audio(session, [0.0] * 4_000, 16000),
            ("회의 내용을 정상적으로 기록했습니다.", "Korean"),
        )
        self.assertEqual(session.calls, [{"context": ""}])

    def test_expanded_decode_allows_only_the_existing_cleanup_retry(self):
        session = FakeSession([
            SimpleNamespace(
                text="Welcome back",
                language="English",
                truncated=True,
            ),
            SimpleNamespace(
                text="Welcome 就就死掉了 back to the show",
                language="English",
                truncated=False,
            ),
            SimpleNamespace(
                text="Welcome back to the show",
                language="English",
                truncated=False,
            ),
        ])

        self.assertEqual(
            transcribe_meeting_audio(session, [0.0] * 4_000, 16000),
            ("Welcome back to the show", "English"),
        )
        self.assertEqual(session.calls, [
            {"context": ""},
            {"context": "", "max_new_tokens": 512},
            {"context": "", "language": "English"},
        ])

    def test_bad_english_decode_is_retried_as_english(self):
        session = FakeSession([
            SimpleNamespace(text="Welcome 就就死掉了 back to the show", language="English"),
            SimpleNamespace(text="Welcome back to the show", language="English"),
        ])
        text, language = transcribe_meeting_audio(session, [0.0] * 4_000, 16000)
        self.assertEqual(text, "Welcome back to the show")
        self.assertEqual(language, "English")
        self.assertEqual(session.calls[1]["language"], "English")

    def test_retry_failure_preserves_the_usable_first_decode(self):
        original = "Welcome 就就死掉了 back to the show"
        session = FakeSession([
            SimpleNamespace(text=original, language="English"),
            RuntimeError("temporary retry failure"),
        ])
        text, language = transcribe_meeting_audio(session, [0.0] * 4_000, 16000)
        self.assertEqual(text, original)
        self.assertEqual(language, "English")
        self.assertEqual(session.calls[1]["language"], "English")

    def test_retry_language_uses_script_when_detection_is_unknown(self):
        self.assertEqual(retry_language("회의 내용을 就就死掉了 정리합니다", "unknown"), "Korean")
        self.assertEqual(retry_language("welcome back 就就死掉了", "unknown"), "English")
        self.assertEqual(retry_language("这是中文内容", "Chinese"), "Chinese")

    def test_join_transcript_normalizes_block_boundaries(self):
        self.assertEqual(join_transcript(" 첫 문장 ", "", " 다음 문장"), "첫 문장 다음 문장")

    def test_overlapping_transcript_windows_are_deduplicated(self):
        self.assertEqual(
            merge_transcript_text("오늘 회의 안건을 설명합니다", "회의 안건을 설명합니다 다음 내용입니다"),
            "오늘 회의 안건을 설명합니다 다음 내용입니다",
        )

    def test_non_overlapping_blocks_preserve_repeated_boundary_words(self):
        self.assertEqual(join_transcript("들어오세요 네", "네 다음 문장"), "들어오세요 네 네 다음 문장")

    def test_silence_boundary_prefers_quiet_valley_near_target(self):
        import numpy as np

        audio = np.ones(2_400, dtype=np.float32) * 0.2
        audio[1_780:1_820] = 0.0
        boundary = choose_silence_boundary(audio, sample_rate=100)
        self.assertGreaterEqual(boundary, 1_760)
        self.assertLessEqual(boundary, 1_840)

    def test_long_meeting_segments_reuse_bounded_live_blocks(self):
        diarization = [
            SimpleNamespace(speaker=0, start=0.0, end=38.0),
            SimpleNamespace(speaker=1, start=40.0, end=60.0),
        ]
        blocks = [
            {"start": 0.0, "end": 20.0, "text": "첫 번째 블록"},
            {"start": 20.0, "end": 40.0, "text": "두 번째 블록"},
            {"start": 40.0, "end": 60.0, "text": "세 번째 블록"},
        ]
        self.assertEqual(
            build_rolling_speaker_segments(blocks, diarization, 60.0),
            [
                {"speaker": 1, "text": "첫 번째 블록 두 번째 블록", "start": 0.0, "end": 40.0},
                {"speaker": 2, "text": "세 번째 블록", "start": 40.0, "end": 60.0},
            ],
        )

    def test_long_block_allocates_simple_a_b_turns_at_sentence_boundary(self):
        text = "첫 문장을 말합니다. 두 번째 문장을 답합니다."
        diarization = [
            SimpleNamespace(speaker=0, start=1.0, end=8.0),
            SimpleNamespace(speaker=1, start=12.0, end=19.0),
        ]

        segments = build_rolling_speaker_segments(
            [{"start": 0.0, "end": 20.0, "text": text}],
            diarization,
            20.0,
        )

        self.assertEqual(segments, [
            {
                "speaker": 1,
                "text": "첫 문장을 말합니다.",
                "start": 0.0,
                "end": 7.0,
            },
            {
                "speaker": 2,
                "text": "두 번째 문장을 답합니다.",
                "start": 7.0,
                "end": 20.0,
            },
        ])
        self.assertEqual(join_transcript(*(part["text"] for part in segments)), text)

    def test_long_block_allocates_simple_a_b_a_turns(self):
        text = "첫 문장입니다. 둘째 문장입니다. 마지막 문장입니다."
        diarization = [
            SimpleNamespace(speaker=0, start=0.0, end=6.0),
            SimpleNamespace(speaker=1, start=6.0, end=14.0),
            SimpleNamespace(speaker=0, start=14.0, end=20.0),
        ]

        segments = build_rolling_speaker_segments(
            [{"start": 0.0, "end": 20.0, "text": text}],
            diarization,
            20.0,
        )

        self.assertEqual(
            [part["speaker"] for part in segments],
            [1, 2, 1],
        )
        self.assertEqual(
            [part["text"] for part in segments],
            ["첫 문장입니다.", "둘째 문장입니다.", "마지막 문장입니다."],
        )
        self.assertEqual(
            [(part["start"], part["end"]) for part in segments],
            [
                (0.0, 20.0 / 3.0),
                (20.0 / 3.0, 40.0 / 3.0),
                (40.0 / 3.0, 20.0),
            ],
        )
        self.assertEqual(join_transcript(*(part["text"] for part in segments)), text)

    def test_long_a_b_a_gate_uses_summed_duration_per_speaker(self):
        text = "하나. 둘. 셋. 넷. 다섯. 여섯. 일곱. 여덟. 아홉. 열."
        diarization = [
            SimpleNamespace(speaker=0, start=0.0, end=1.1),
            SimpleNamespace(speaker=1, start=1.1, end=18.9),
            SimpleNamespace(speaker=0, start=18.9, end=20.0),
        ]

        segments = build_rolling_speaker_segments(
            [{"start": 0.0, "end": 20.0, "text": text}],
            diarization,
            20.0,
        )

        self.assertEqual(
            [part["speaker"] for part in segments],
            [1, 2, 1],
        )
        self.assertEqual(join_transcript(*(part["text"] for part in segments)), text)

    def test_long_block_with_three_speakers_keeps_dominant_fallback(self):
        text = "첫 문장입니다. 둘째 문장입니다. 셋째 문장입니다."
        diarization = [
            SimpleNamespace(speaker=0, start=0.0, end=8.0),
            SimpleNamespace(speaker=1, start=8.0, end=14.0),
            SimpleNamespace(speaker=2, start=14.0, end=20.0),
        ]

        self.assertEqual(
            build_rolling_speaker_segments(
                [{"start": 0.0, "end": 20.0, "text": text}],
                diarization,
                20.0,
            ),
            [{"speaker": 1, "text": text, "start": 0.0, "end": 20.0}],
        )

    def test_long_block_with_more_than_three_turns_keeps_dominant_fallback(self):
        text = "하나입니다. 둘입니다. 셋입니다. 넷입니다."
        diarization = [
            SimpleNamespace(speaker=index % 2, start=index * 5.0, end=(index + 1) * 5.0)
            for index in range(4)
        ]

        self.assertEqual(
            build_rolling_speaker_segments(
                [{"start": 0.0, "end": 20.0, "text": text}],
                diarization,
                20.0,
            ),
            [{"speaker": 1, "text": text, "start": 0.0, "end": 20.0}],
        )

    def test_long_block_rejects_a_1_99_second_secondary_turn(self):
        text = "긴 답변입니다. 짧은 답변입니다."
        diarization = [
            SimpleNamespace(speaker=0, start=0.0, end=18.01),
            SimpleNamespace(speaker=1, start=18.01, end=20.0),
        ]

        self.assertEqual(
            build_rolling_speaker_segments(
                [{"start": 0.0, "end": 20.0, "text": text}],
                diarization,
                20.0,
            ),
            [{"speaker": 1, "text": text, "start": 0.0, "end": 20.0}],
        )

    def test_long_block_scales_minimum_turn_to_ten_percent(self):
        text = "긴 답변입니다. 짧은 답변입니다."
        diarization = [
            SimpleNamespace(speaker=0, start=0.0, end=36.01),
            SimpleNamespace(speaker=1, start=36.01, end=40.0),
        ]

        self.assertEqual(
            build_rolling_speaker_segments(
                [{"start": 0.0, "end": 40.0, "text": text}],
                diarization,
                40.0,
            ),
            [{"speaker": 1, "text": text, "start": 0.0, "end": 40.0}],
        )

    def test_long_block_preserves_repeated_short_utterances(self):
        text = "네. 네."
        diarization = [
            SimpleNamespace(speaker=0, start=0.0, end=10.0),
            SimpleNamespace(speaker=1, start=10.0, end=20.0),
        ]

        segments = build_rolling_speaker_segments(
            [{"start": 0.0, "end": 20.0, "text": text}],
            diarization,
            20.0,
        )

        self.assertEqual([part["text"] for part in segments], ["네.", "네."])
        self.assertEqual(
            [(part["start"], part["end"]) for part in segments],
            [(0.0, 10.0), (10.0, 20.0)],
        )
        self.assertEqual(join_transcript(*(part["text"] for part in segments)), text)

    def test_long_block_sentence_boundary_tie_chooses_earlier_split(self):
        text = "하나 둘. 셋 넷 다섯 여섯. 일곱 여덟"
        diarization = [
            SimpleNamespace(speaker=0, start=0.0, end=10.0),
            SimpleNamespace(speaker=1, start=10.0, end=20.0),
        ]

        segments = build_rolling_speaker_segments(
            [{"start": 0.0, "end": 20.0, "text": text}],
            diarization,
            20.0,
        )

        # The middle sentence has two tokens on each side of the duration
        # boundary, so the speaker that occurs first wins the exact tie.
        self.assertEqual(segments[0]["text"], "하나 둘. 셋 넷 다섯 여섯.")
        self.assertEqual(segments[1]["text"], "일곱 여덟")
        self.assertEqual(join_transcript(*(part["text"] for part in segments)), text)

    def test_long_block_without_sentence_boundary_keeps_dominant_fallback(self):
        text = "문장 부호가 없는 하나의 긴 발화입니다"
        diarization = [
            SimpleNamespace(speaker=0, start=0.0, end=10.0),
            SimpleNamespace(speaker=1, start=10.0, end=20.0),
        ]

        self.assertEqual(
            build_rolling_speaker_segments(
                [{"start": 0.0, "end": 20.0, "text": text}],
                diarization,
                20.0,
            ),
            [{"speaker": 1, "text": text, "start": 0.0, "end": 20.0}],
        )

    def test_long_block_keeps_legacy_empty_and_no_diarization_fallbacks(self):
        self.assertEqual(
            build_rolling_speaker_segments([], [], 60.0),
            [{"speaker": None, "text": "", "start": 0.0, "end": 60.0}],
        )
        self.assertEqual(
            build_rolling_speaker_segments(
                [
                    {"start": 0.0, "end": 20.0, "text": ""},
                    {"start": 20.0, "end": 40.0, "text": "기존 문장"},
                ],
                [],
                60.0,
            ),
            [{
                "speaker": None,
                "text": "기존 문장",
                "start": 20.0,
                "end": 40.0,
            }],
        )

    def test_six_hour_finalize_uses_only_compact_text_blocks(self):
        blocks = [
            {"start": index * 20.0, "end": (index + 1) * 20.0, "text": f"블록 {index}"}
            for index in range(1_080)
        ]
        diarization = [
            SimpleNamespace(speaker=(index // 90) % 2, start=index * 20.0, end=(index + 1) * 20.0)
            for index in range(1_080)
        ]
        segments = build_rolling_speaker_segments(blocks, diarization, 21_600.0)
        self.assertEqual(segments[0]["start"], 0.0)
        self.assertEqual(segments[-1]["end"], 21_600.0)
        self.assertLessEqual(len(segments), 12)
        self.assertIn("블록 1079", segments[-1]["text"])
        self.assertTrue(all(
            previous["end"] <= following["start"]
            for previous, following in zip(segments, segments[1:])
        ))
        self.assertEqual(
            join_transcript(*(segment["text"] for segment in segments)),
            join_transcript(*(block["text"] for block in blocks)),
        )

    def test_long_finalize_does_not_run_full_file_diarization(self):
        class FailingDiarizer:
            def generate(self, *_args, **_kwargs):
                raise AssertionError("long meetings must not run full-file diarization")

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "meeting.wav"
            with wave.open(str(path), "wb") as target:
                target.setnchannels(1)
                target.setsampwidth(2)
                target.setframerate(16_000)
                target.writeframes(b"\0\0" * 16)
            with patch("asr_worker.emit"):
                segments = finalize_speakers(
                    path,
                    object(),
                    FailingDiarizer(),
                    "첫 블록",
                    refined_blocks=[{"start": 0.0, "end": 20.0, "text": "첫 블록"}],
                    duration_hint=3_600.0,
                )
        self.assertEqual(segments[0]["text"], "첫 블록")

    def test_podcast_length_finalize_stays_below_full_file_memory_limit(self):
        class FailingDiarizer:
            def generate(self, *_args, **_kwargs):
                raise AssertionError("podcast-length audio must reuse streaming diarization")

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "meeting.wav"
            self.write_silent_wav(path)
            with patch("asr_worker.emit"):
                segments = finalize_speakers(
                    path,
                    object(),
                    FailingDiarizer(),
                    "전체 팟캐스트 문장",
                    refined_blocks=[{
                        "start": 0.0,
                        "end": 20.0,
                        "text": "전체 팟캐스트 문장",
                    }],
                    duration_hint=28.0 * 60.0,
                )

        self.assertEqual(FULL_FILE_DIARIZATION_LIMIT_SECONDS, 5.0 * 60.0)
        self.assertEqual(segments[0]["text"], "전체 팟캐스트 문장")

    def test_long_finalize_with_no_blocks_never_attempts_full_file_diarization(self):
        class FailingDiarizer:
            def generate(self, *_args, **_kwargs):
                raise AssertionError("long audio must never use full-file diarization")

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "meeting.wav"
            self.write_silent_wav(path)
            with patch("asr_worker.emit"):
                segments = finalize_speakers(
                    path,
                    object(),
                    FailingDiarizer(),
                    "복구된 전체 문장",
                    refined_blocks=[],
                    duration_hint=28.0 * 60.0,
                )

        self.assertEqual(segments, [{
            "speaker": None,
            "text": "복구된 전체 문장",
            "start": 0.0,
            "end": 28.0 * 60.0,
        }])

    def test_long_finalize_rejects_blocks_that_do_not_reproduce_canonical_text(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "meeting.wav"
            self.write_silent_wav(path)
            with patch("asr_worker.emit"):
                segments = finalize_speakers(
                    path,
                    object(),
                    object(),
                    "alpha beta gamma",
                    refined_blocks=[{"start": 0.0, "end": 20.0, "text": "alpha beta"}],
                    duration_hint=10.0 * 60.0,
                )

        self.assertEqual(segments, [{
            "speaker": None,
            "text": "alpha beta gamma",
            "start": 0.0,
            "end": 10.0 * 60.0,
        }])

    def test_validated_diarization_threshold_is_used_for_full_file_generation(self):
        diarizer = self.diarizer()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "meeting.wav"
            self.write_silent_wav(path)
            with patch("asr_worker.emit"):
                finalize_speakers(path, FakeSession([]), diarizer, "fallback")

        self.assertEqual(DIARIZATION_THRESHOLD, 0.40)
        self.assertEqual(diarizer.calls[0][1]["threshold"], DIARIZATION_THRESHOLD)

    def test_full_finalize_builds_probability_timeline_from_trimmed_model_audio(self):
        import numpy as np

        captured = {}

        class TimelineDiarizer:
            def __init__(self):
                self.model_audio = np.zeros(64_000, dtype=np.float32)
                self.probabilities = np.zeros((400, 2), dtype=np.float32)
                self._processor_config = SimpleNamespace(hop_length=160)
                self.config = SimpleNamespace(
                    fc_encoder_config=SimpleNamespace(subsampling_factor=8),
                )

            def _load_audio(self, audio, sample_rate):
                captured["loaded"] = (audio, sample_rate)
                return self.model_audio, 16_000

            def _trim_silence(self, audio, sample_rate):
                captured["trimmed"] = (audio, sample_rate)
                return audio[16_000:48_000], 16_000

            def generate(self, audio, **kwargs):
                captured["generated"] = (audio, kwargs)
                return SimpleNamespace(
                    segments=[],
                    speaker_probs=self.probabilities,
                )

        diarizer = TimelineDiarizer()

        def capture_merge(raw_segments, duration, speaker_timeline):
            captured["merged"] = (raw_segments, duration, speaker_timeline)
            return []

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "meeting.wav"
            self.write_silent_wav(path)
            with patch("asr_worker.emit"), \
                 patch("asr_worker.merge_turns", side_effect=capture_merge):
                finalize_speakers(path, FakeSession([]), diarizer, "fallback")

        self.assertIs(captured["trimmed"][0], diarizer.model_audio)
        self.assertIs(captured["generated"][0], diarizer.model_audio)
        self.assertEqual(captured["generated"][1]["sample_rate"], 16_000)
        self.assertEqual(
            captured["generated"][1]["threshold"],
            DIARIZATION_THRESHOLD,
        )
        timeline = captured["merged"][2]
        self.assertIsInstance(timeline, SpeakerProbabilityTimeline)
        self.assertIs(timeline.values, diarizer.probabilities)
        self.assertEqual(timeline.start_seconds, 1.0)
        self.assertEqual(timeline.frame_seconds, 0.08)

    def test_full_finalize_rejects_unexpected_probability_shape(self):
        import numpy as np

        captured = {}

        class BadShapeDiarizer:
            def __init__(self):
                self.model_audio = np.zeros(32_000, dtype=np.float32)
                self._processor_config = SimpleNamespace(hop_length=160)
                self.config = SimpleNamespace(
                    fc_encoder_config=SimpleNamespace(subsampling_factor=8),
                )

            def _load_audio(self, _audio, _sample_rate):
                return self.model_audio, 16_000

            def _trim_silence(self, audio, _sample_rate):
                return audio, 0

            def generate(self, _audio, **_kwargs):
                return SimpleNamespace(
                    segments=[],
                    speaker_probs=np.zeros(10, dtype=np.float32),
                )

        def capture_merge(_raw_segments, _duration, speaker_timeline):
            captured["timeline"] = speaker_timeline
            return []

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "meeting.wav"
            self.write_silent_wav(path)
            with patch("asr_worker.emit"), \
                 patch("asr_worker.merge_turns", side_effect=capture_merge):
                finalize_speakers(
                    path,
                    FakeSession([]),
                    BadShapeDiarizer(),
                    "fallback",
                )

        self.assertIsNone(captured["timeline"])

    def test_full_finalize_disables_probabilities_when_private_contract_is_missing(self):
        import numpy as np

        captured = {}

        class NoPrivateApiDiarizer:
            def generate(self, audio, **_kwargs):
                captured["generation_audio"] = audio
                return SimpleNamespace(
                    segments=[],
                    speaker_probs=np.zeros((10, 2), dtype=np.float32),
                )

        def capture_merge(_raw_segments, _duration, speaker_timeline):
            captured["timeline"] = speaker_timeline
            return []

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "meeting.wav"
            self.write_silent_wav(path)
            with patch("asr_worker.emit"), \
                 patch("asr_worker.merge_turns", side_effect=capture_merge):
                finalize_speakers(
                    path,
                    FakeSession([]),
                    NoPrivateApiDiarizer(),
                    "fallback",
                )

        self.assertIsInstance(captured["generation_audio"], str)
        self.assertIsNone(captured["timeline"])

    def test_validated_diarization_threshold_is_used_for_live_audio(self):
        import numpy as np

        calls = []

        class LiveSession:
            def __init__(self, **_kwargs):
                pass

            def init_streaming(self, **_kwargs):
                return SimpleNamespace(language="", stable_text="", text="")

            def feed_audio(self, _audio, state):
                return state

        class LiveDiarizer:
            def init_streaming_state(self):
                return object()

            def feed(self, _audio, state, **kwargs):
                calls.append(kwargs)
                return SimpleNamespace(segments=[]), state

        fake_mlx = ModuleType("mlx")
        fake_mlx_core = ModuleType("mlx.core")
        fake_mlx_core.set_cache_limit = lambda _limit: None
        fake_mlx.core = fake_mlx_core
        fake_qwen = ModuleType("mlx_qwen3_asr")
        fake_qwen.Session = LiveSession
        fake_streaming = ModuleType("mlx_qwen3_asr.streaming")
        fake_streaming._CJK_LANG_ALIASES = {"chinese", "japanese", "korean"}
        fake_qwen.streaming = fake_streaming
        fake_mlx_audio = ModuleType("mlx_audio")
        fake_vad = ModuleType("mlx_audio.vad")
        fake_vad.load = lambda _path: LiveDiarizer()
        fake_mlx_audio.vad = fake_vad
        modules = {
            "mlx": fake_mlx,
            "mlx.core": fake_mlx_core,
            "mlx_qwen3_asr": fake_qwen,
            "mlx_qwen3_asr.streaming": fake_streaming,
            "mlx_audio": fake_mlx_audio,
            "mlx_audio.vad": fake_vad,
        }
        frames = [(1, np.zeros(8, dtype="<f4").tobytes()), (3, b"")]
        args = SimpleNamespace(model_dir="/tmp/models", audio_path="/tmp/meeting.wav")

        with patch.dict(sys.modules, modules), \
             patch("asr_worker.prepare_model", return_value=Path("/tmp/model")), \
             patch("asr_worker.read_frame", side_effect=frames), \
             patch("asr_worker.emit"):
            run_real(args)

        self.assertEqual(calls[0]["threshold"], DIARIZATION_THRESHOLD)

    def test_empty_turn_retranscription_uses_lossless_speaker_fallback(self):
        raw = [
            SimpleNamespace(speaker=0, start=0.0, end=2.0),
            SimpleNamespace(speaker=1, start=2.0, end=4.0),
        ]
        blocks = [
            {"start": 0.0, "end": 2.0, "text": "alpha beta"},
            {"start": 2.0, "end": 4.0, "text": "gamma delta"},
        ]
        session = FakeSession([
            SimpleNamespace(text="alpha beta", language="English"),
            SimpleNamespace(text="", language="English"),
        ])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "meeting.wav"
            self.write_silent_wav(path)
            with patch("asr_worker.emit"):
                segments = finalize_speakers(
                    path,
                    session,
                    self.diarizer(*raw),
                    "alpha beta gamma delta",
                    refined_blocks=blocks,
                )

        self.assertEqual(segments, [
            {"speaker": 1, "text": "alpha beta", "start": 0.0, "end": 2.0},
            {"speaker": 2, "text": "gamma delta", "start": 2.0, "end": 4.0},
        ])

    def test_turn_retranscription_exception_never_returns_partial_text(self):
        raw = [
            SimpleNamespace(speaker=0, start=0.0, end=2.0),
            SimpleNamespace(speaker=1, start=2.0, end=4.0),
        ]
        session = FakeSession([
            SimpleNamespace(text="partial result", language="English"),
            RuntimeError("decode failed"),
        ])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "meeting.wav"
            self.write_silent_wav(path)
            with patch("asr_worker.emit"):
                segments = finalize_speakers(
                    path,
                    session,
                    self.diarizer(*raw),
                    "complete fallback transcript",
                    refined_blocks=[{"start": 0.0, "end": 2.0, "text": "incomplete"}],
                )

        self.assertEqual(segments, [{
            "speaker": None,
            "text": "complete fallback transcript",
            "start": 0.0,
            "end": 4.0,
        }])

    def test_short_multi_speaker_retranscription_uses_complete_fallback(self):
        raw = [
            SimpleNamespace(speaker=0, start=0.0, end=2.0),
            SimpleNamespace(speaker=1, start=2.0, end=4.0),
        ]
        session = FakeSession([
            SimpleNamespace(text="abcd", language="English"),
            SimpleNamespace(text="efgh", language="English"),
        ])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "meeting.wav"
            self.write_silent_wav(path)
            with patch("asr_worker.emit"):
                segments = finalize_speakers(
                    path,
                    session,
                    self.diarizer(*raw),
                    "abcdefghij",
                )

        self.assertEqual(segments, [{
            "speaker": None,
            "text": "abcdefghij",
            "start": 0.0,
            "end": 4.0,
        }])

    def test_retranscription_length_threshold_accepts_exactly_ninety_five_percent(self):
        fallback = "b" * 100 + "..."
        self.assertTrue(has_sufficient_retranscription("a" * 95, fallback))
        self.assertFalse(has_sufficient_retranscription("a" * 94, fallback))

    def test_short_monologue_retranscription_uses_same_lossless_fallback(self):
        raw = [SimpleNamespace(speaker=0, start=0.0, end=4.0)]
        blocks = [{"start": 0.0, "end": 4.0, "text": "complete fallback transcript"}]
        session = FakeSession([
            SimpleNamespace(text="too short", language="English"),
        ])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "meeting.wav"
            self.write_silent_wav(path)
            with patch("asr_worker.emit"):
                segments = finalize_speakers(
                    path,
                    session,
                    self.diarizer(*raw),
                    "complete fallback transcript",
                    refined_blocks=blocks,
                )

        self.assertEqual(segments, [{
            "speaker": 1,
            "text": "complete fallback transcript",
            "start": 0.0,
            "end": 4.0,
        }])

    def test_complete_retranscription_preserves_normal_speaker_result(self):
        raw = [
            SimpleNamespace(speaker=0, start=0.0, end=2.0),
            SimpleNamespace(speaker=1, start=2.0, end=4.0),
        ]
        session = FakeSession([
            SimpleNamespace(text="alpha beta", language="English"),
            SimpleNamespace(text="gamma delta", language="English"),
        ])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "meeting.wav"
            self.write_silent_wav(path)
            with patch("asr_worker.emit"):
                segments = finalize_speakers(
                    path,
                    session,
                    self.diarizer(*raw),
                    "alpha beta gamma delta",
                )

        self.assertEqual([segment["speaker"] for segment in segments], [1, 2])
        self.assertEqual([segment["text"] for segment in segments], ["alpha beta", "gamma delta"])

    def test_speaker_alignment_drops_insertions_and_preserves_canonical_text(self):
        aligned = align_canonical_text_to_speakers(
            "alpha beta gamma",
            [
                {"speaker": 1, "text": "alpha extra", "start": 0.0, "end": 2.0},
                {"speaker": 2, "text": "beta gamma", "start": 2.0, "end": 4.0},
            ],
        )

        self.assertEqual(aligned, [
            {"speaker": 1, "text": "alpha", "start": 0.0, "end": 2.0},
            {"speaker": 2, "text": "beta gamma", "start": 2.0, "end": 4.0},
        ])
        self.assertEqual(" ".join(segment["text"] for segment in aligned), "alpha beta gamma")

    def test_speaker_alignment_rejects_unrelated_hypotheses(self):
        self.assertIsNone(align_canonical_text_to_speakers(
            "one two three four five six",
            [{"speaker": 1, "text": "완전히 관계없는 문장", "start": 0.0, "end": 2.0}],
        ))

    def test_repeated_exchange_keeps_both_occurrences_on_their_original_clock(self):
        canonical = (
            "today we will ship on friday. yes lets check. "
            "today we will ship on friday. yes let us check."
        )
        aligned = align_canonical_text_to_speakers(canonical, [
            {"speaker": 1, "text": "today we ship friday.", "start": 0.0, "end": 5.0},
            {"speaker": 2, "text": "yes let's verify.", "start": 5.0, "end": 10.0},
            {"speaker": 1, "text": "today we will ship on friday.", "start": 10.0, "end": 15.0},
            {"speaker": 2, "text": "yes lets check.", "start": 15.0, "end": 20.0},
        ])

        self.assertIsNotNone(aligned)
        self.assertEqual([segment["speaker"] for segment in aligned], [1, 2, 1, 2])
        self.assertEqual([segment["start"] for segment in aligned], [0.0, 5.0, 10.0, 15.0])
        self.assertEqual([segment["text"] for segment in aligned], [
            "today we will ship on friday.", "yes lets check.",
            "today we will ship on friday.", "yes let us check.",
        ])
        self.assertEqual(" ".join(segment["text"] for segment in aligned), canonical)

    def test_repeated_exchanges_keep_order_across_many_turns(self):
        texts = ["today we will ship on friday.", "yes lets check."] * 12
        hypotheses = ["today we ship friday.", "yes let's verify."] * 11 + texts[-2:]
        aligned = align_canonical_text_to_speakers(" ".join(texts), [
            {"speaker": index % 2 + 1, "text": text,
             "start": index * 5.0, "end": (index + 1) * 5.0}
            for index, text in enumerate(hypotheses)
        ])

        self.assertIsNotNone(aligned)
        self.assertEqual([segment["text"] for segment in aligned], texts)
        self.assertEqual([segment["start"] for segment in aligned],
                         [index * 5.0 for index in range(len(texts))])

    def test_alignment_preserves_original_unicode_and_punctuation(self):
        for texts, hypotheses in [
            (["오늘 회의 결과입니다.", "네, 확인했습니다!"],
             ["오늘 회의 결과입니다", "네 확인했습니다"]),
            (["会議の結果です。", "はい、確認しました！"],
             ["会議の結果です", "はい確認しました"]),
            (["Ｆｒｉｄａｙ — delivery!", "YES, confirmed."],
             ["friday delivery", "yes confirmed"]),
        ]:
            with self.subTest(texts=texts):
                canonical = " ".join(texts)
                aligned = align_canonical_text_to_speakers(canonical, [
                    {"speaker": index + 1, "text": text,
                     "start": index * 5.0, "end": (index + 1) * 5.0}
                    for index, text in enumerate(hypotheses)
                ])
                self.assertIsNotNone(aligned)
                self.assertEqual([segment["text"] for segment in aligned], texts)
                self.assertEqual(" ".join(segment["text"] for segment in aligned), canonical)

    def test_oversized_alignment_uses_lossless_finalization_fallback(self):
        canonical = " ".join(f"word{index}" for index in range(2100))
        raw = [
            SimpleNamespace(speaker=0, start=0.0, end=2.0),
            SimpleNamespace(speaker=1, start=2.0, end=4.0),
        ]
        session = FakeSession([
            SimpleNamespace(text=canonical, language="English"),
            SimpleNamespace(text=canonical, language="English"),
        ])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "meeting.wav"
            self.write_silent_wav(path)
            with patch("asr_worker.emit"):
                segments = finalize_speakers(path, session, self.diarizer(*raw), canonical)

        self.assertEqual(segments, [{
            "speaker": None, "text": canonical, "start": 0.0, "end": 4.0,
        }])

    def test_identical_long_alignment_needs_no_quadratic_matrix(self):
        words = [f"word{index}" for index in range(3000)]
        aligned = align_canonical_text_to_speakers(" ".join(words), [
            {"speaker": 1, "text": " ".join(words[:1500]), "start": 0.0, "end": 100.0},
            {"speaker": 2, "text": " ".join(words[1500:]), "start": 100.0, "end": 200.0},
        ])

        self.assertIsNotNone(aligned)
        self.assertEqual([segment["speaker"] for segment in aligned], [1, 2])
        self.assertEqual(" ".join(segment["text"] for segment in aligned), " ".join(words))

    def test_speaker_alignment_recovers_insertion_only_middle_speaker(self):
        aligned = align_canonical_text_to_speakers(
            "alpha beta gamma delta epsilon",
            [
                {"speaker": 1, "text": "alpha beta", "start": 0.0, "end": 2.0},
                {"speaker": 2, "text": "noise", "start": 2.0, "end": 3.0},
                {"speaker": 3, "text": "gamma delta epsilon", "start": 3.0, "end": 5.0},
            ],
        )

        self.assertEqual(aligned, [
            {"speaker": 1, "text": "alpha beta", "start": 0.0, "end": 2.0},
            {"speaker": 2, "text": "gamma", "start": 2.0, "end": 3.0},
            {"speaker": 3, "text": "delta epsilon", "start": 3.0, "end": 5.0},
        ])
        self.assertEqual(
            " ".join(segment["text"] for segment in aligned),
            "alpha beta gamma delta epsilon",
        )

    def test_speaker_alignment_does_not_empty_one_token_donor(self):
        aligned = align_canonical_text_to_speakers(
            "alpha beta",
            [
                {"speaker": 1, "text": "alpha", "start": 0.0, "end": 2.0},
                {"speaker": 2, "text": "noise", "start": 2.0, "end": 3.0},
                {"speaker": 3, "text": "beta", "start": 3.0, "end": 5.0},
            ],
        )

        self.assertEqual(aligned, [
            {"speaker": 1, "text": "alpha", "start": 0.0, "end": 2.0},
            {"speaker": 3, "text": "beta", "start": 3.0, "end": 5.0},
        ])

    def test_speaker_alignment_does_not_split_already_represented_speaker(self):
        aligned = align_canonical_text_to_speakers(
            "alpha beta gamma delta",
            [
                {"speaker": 1, "text": "alpha", "start": 0.0, "end": 1.0},
                {"speaker": 2, "text": "noise", "start": 1.0, "end": 2.0},
                {"speaker": 2, "text": "beta gamma", "start": 2.0, "end": 4.0},
                {"speaker": 3, "text": "delta", "start": 4.0, "end": 5.0},
            ],
        )

        self.assertEqual(aligned, [
            {"speaker": 1, "text": "alpha", "start": 0.0, "end": 1.0},
            {"speaker": 2, "text": "beta gamma", "start": 2.0, "end": 4.0},
            {"speaker": 3, "text": "delta", "start": 4.0, "end": 5.0},
        ])

    def test_long_final_turn_is_transcribed_in_bounded_windows(self):
        session = FakeSession([
            SimpleNamespace(text=f"문장 {index}", language="Korean")
            for index in range(7)
        ])
        text = transcribe_audio_windowed(
            session,
            [0.0] * 65,
            sample_rate=1,
            max_window_sec=10,
        )

        self.assertEqual(len(session.calls), 7)
        self.assertEqual(text, "문장 0 문장 1 문장 2 문장 3 문장 4 문장 5 문장 6")

    def test_windowed_final_turn_preserves_a_repeated_boundary_word(self):
        session = FakeSession([
            SimpleNamespace(text="첫 문장 경계", language="Korean"),
            SimpleNamespace(text="경계 다음 문장", language="Korean"),
        ])

        text = transcribe_audio_windowed(
            session,
            [0.0] * 20,
            sample_rate=1,
            max_window_sec=10,
        )

        self.assertEqual(text, "첫 문장 경계 경계 다음 문장")

    def test_short_false_speaker_is_folded_into_neighbor(self):
        raw = [
            SimpleNamespace(speaker=0, start=0.0, end=5.0),
            SimpleNamespace(speaker=3, start=5.1, end=6.0),
            SimpleNamespace(speaker=0, start=6.1, end=11.0),
        ]
        turns = merge_turns(raw, 11.0)
        self.assertEqual(turns, [{"speaker": 1, "start": 0.0, "end": 11.0}])

    def test_trailing_silence_does_not_erase_a_short_real_speaker(self):
        raw = [
            SimpleNamespace(speaker=0, start=0.0, end=46.0),
            SimpleNamespace(speaker=1, start=46.0, end=48.0),
        ]

        original = merge_turns(raw, 60.0)
        silence_padded = merge_turns(raw, 240.0)

        self.assertEqual(original, [
            {"speaker": 1, "start": 0.0, "end": 46.0},
            {"speaker": 2, "start": 46.0, "end": 48.0},
        ])
        self.assertEqual(silence_padded, original)

    def test_dense_speech_keeps_proportional_false_speaker_threshold(self):
        raw = [
            SimpleNamespace(speaker=0, start=0.0, end=240.0),
            SimpleNamespace(speaker=1, start=100.0, end=104.0),
        ]

        turns = merge_turns(raw, 240.0)

        self.assertEqual(turns, [
            {"speaker": 1, "start": 0.0, "end": 240.0},
        ])

    def test_probability_timeline_indexes_frames_after_leading_silence_directly(self):
        timeline = probability_timeline(
            [[0.9, 0.1], [0.1, 0.9]],
            start_seconds=10.0,
            frame_seconds=2.0,
        )

        self.assertAlmostEqual(
            mean_speaker_probability(timeline, 0, 10.0, 12.0),
            0.9,
        )
        self.assertAlmostEqual(
            mean_speaker_probability(timeline, 1, 12.0, 14.0),
            0.9,
        )
        self.assertIsNone(
            mean_speaker_probability(timeline, 0, 0.0, 2.0),
        )
        self.assertIsNone(
            mean_speaker_probability(timeline.values, 0, 10.0, 12.0),
        )

    def test_overlap_winner_uses_trimmed_probability_origin(self):
        raw = [
            SimpleNamespace(speaker=0, start=10.0, end=12.0),
            SimpleNamespace(speaker=1, start=10.0, end=14.0),
        ]
        timeline = probability_timeline(
            [[0.9, 0.1], [0.1, 0.9]],
            start_seconds=10.0,
            frame_seconds=2.0,
        )

        turns = merge_turns(raw, 20.0, timeline)

        self.assertEqual(turns, [
            {"speaker": 1, "start": 10.0, "end": 12.0},
            {"speaker": 2, "start": 12.0, "end": 14.0},
        ])

    def test_overlapping_speech_is_assigned_once_to_higher_probability_speaker(self):
        raw = [
            SimpleNamespace(speaker=0, start=0.0, end=5.0),
            SimpleNamespace(speaker=1, start=3.0, end=8.0),
        ]
        probabilities = [
            [0.9, 0.1],
            [0.9, 0.1],
            [0.9, 0.1],
            [0.2, 0.9],
            [0.2, 0.9],
            [0.1, 0.9],
            [0.1, 0.9],
            [0.1, 0.9],
        ]
        turns = merge_turns(raw, 8.0, probability_timeline(probabilities))

        self.assertEqual(turns, [
            {"speaker": 1, "start": 0.0, "end": 3.0},
            {"speaker": 2, "start": 3.0, "end": 8.0},
        ])

    def test_long_speaker_resumes_after_short_overlapping_turn(self):
        raw = [
            SimpleNamespace(speaker=0, start=0.0, end=10.0),
            SimpleNamespace(speaker=1, start=3.0, end=5.0),
        ]
        probabilities = [
            [0.9, 0.1],
            [0.9, 0.1],
            [0.9, 0.1],
            [0.1, 0.9],
            [0.1, 0.9],
            [0.9, 0.1],
            [0.9, 0.1],
            [0.9, 0.1],
            [0.9, 0.1],
            [0.9, 0.1],
        ]

        turns = merge_turns(raw, 10.0, probability_timeline(probabilities))

        self.assertEqual(turns, [
            {"speaker": 1, "start": 0.0, "end": 3.0},
            {"speaker": 2, "start": 3.0, "end": 5.0},
            {"speaker": 1, "start": 5.0, "end": 10.0},
        ])

    def test_sustained_fully_overlapped_speakers_are_rescued_by_onset(self):
        raw = [
            SimpleNamespace(speaker=0, start=0.0, end=10.0),
            SimpleNamespace(speaker=1, start=6.0, end=10.0),
            SimpleNamespace(speaker=2, start=8.0, end=9.6),
        ]
        probabilities = [[0.9, 0.7, 0.6] for _ in range(10)]

        turns = merge_turns(raw, 10.0, probability_timeline(probabilities))

        self.assertEqual(turns, [
            {"speaker": 1, "start": 0.0, "end": 6.0},
            {"speaker": 2, "start": 6.0, "end": 8.0},
            {"speaker": 3, "start": 8.0, "end": 10.0},
        ])

    def test_earlier_rescued_speaker_resumes_after_nested_overlap(self):
        raw = [
            SimpleNamespace(speaker=0, start=0.0, end=10.0),
            SimpleNamespace(speaker=1, start=2.0, end=10.0),
            SimpleNamespace(speaker=2, start=4.0, end=6.0),
        ]
        probabilities = [[0.9, 0.7, 0.6] for _ in range(10)]

        turns = merge_turns(raw, 10.0, probability_timeline(probabilities))

        self.assertEqual(turns, [
            {"speaker": 1, "start": 0.0, "end": 2.0},
            {"speaker": 2, "start": 2.0, "end": 4.0},
            {"speaker": 3, "start": 4.0, "end": 6.0},
            {"speaker": 2, "start": 6.0, "end": 10.0},
        ])

    def test_short_new_rescue_head_is_not_absorbed_as_a_resumed_tail(self):
        raw = [
            SimpleNamespace(speaker=0, start=0.0, end=5.0),
            SimpleNamespace(speaker=3, start=5.0, end=10.0),
            SimpleNamespace(speaker=1, start=2.0, end=5.0),
            SimpleNamespace(speaker=2, start=4.5, end=6.0),
        ]
        probabilities = [
            *[[0.9, 0.7, 0.6, 0.1] for _ in range(5)],
            *[[0.1, 0.7, 0.6, 0.9] for _ in range(5)],
        ]

        turns = merge_turns(raw, 10.0, probability_timeline(probabilities))

        self.assertEqual(turns, [
            {"speaker": 1, "start": 0.0, "end": 2.0},
            {"speaker": 2, "start": 2.0, "end": 4.5},
            {"speaker": 3, "start": 4.5, "end": 6.0},
            {"speaker": 4, "start": 6.0, "end": 10.0},
        ])

    def test_scattered_short_overlaps_do_not_rescue_a_noisy_speaker(self):
        raw = [
            SimpleNamespace(speaker=0, start=0.0, end=10.0),
            SimpleNamespace(speaker=1, start=2.0, end=2.8),
            SimpleNamespace(speaker=1, start=6.0, end=6.8),
        ]
        probabilities = [[0.9, 0.4] for _ in range(10)]

        turns = merge_turns(raw, 10.0, probability_timeline(probabilities))

        self.assertEqual(turns, [
            {"speaker": 1, "start": 0.0, "end": 10.0},
        ])

    def test_adjacent_raw_segments_count_as_contiguous_rescue_evidence(self):
        raw = [
            SimpleNamespace(speaker=0, start=0.0, end=10.0),
            SimpleNamespace(speaker=1, start=2.0, end=2.8),
            SimpleNamespace(speaker=1, start=2.8, end=3.6),
        ]
        probabilities = [[0.9, 0.4] for _ in range(10)]

        turns = merge_turns(raw, 10.0, probability_timeline(probabilities))

        self.assertEqual(turns, [
            {"speaker": 1, "start": 0.0, "end": 2.0},
            {"speaker": 2, "start": 2.0, "end": 3.6},
            {"speaker": 1, "start": 3.6, "end": 10.0},
        ])

    def test_partially_selected_speaker_is_not_broadly_rescued(self):
        raw = [
            SimpleNamespace(speaker=0, start=0.0, end=9.0),
            SimpleNamespace(speaker=0, start=9.0, end=10.0),
            SimpleNamespace(speaker=1, start=6.0, end=10.0),
        ]
        probabilities = [
            *[[0.9, 0.1] for _ in range(9)],
            [0.1, 0.9],
        ]

        turns = merge_turns(raw, 10.0, probability_timeline(probabilities))

        self.assertEqual(turns, [
            {"speaker": 1, "start": 0.0, "end": 10.0},
        ])


if __name__ == "__main__":
    unittest.main()
