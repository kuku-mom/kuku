//! Deterministic audio preparation for the meeting pipeline.
//!
//! This module intentionally has no Tauri or worker-process dependencies. It
//! accepts timestamped capture buffers and produces bounded mono 16 kHz frames,
//! which makes the most timing-sensitive part of Kuku independently testable
//! and reusable by other native frontends.

use super::audio_capture::AudioSource;
use std::time::{Duration, Instant};

pub(crate) const SAMPLE_RATE: u32 = 16_000;
pub(crate) const AUDIO_FRAME_SAMPLES: usize = 32_000;
pub(crate) const MAX_MEETING_SECONDS: usize = 6 * 60 * 60;
pub(crate) const MAX_MEETING_SAMPLES: usize = SAMPLE_RATE as usize * MAX_MEETING_SECONDS;
const MAX_ALIGNMENT_SKEW_SECONDS: f64 = 5.0;

pub(crate) fn bounded_audio_take(ready: usize, forwarded: usize) -> usize {
    ready
        .min(AUDIO_FRAME_SAMPLES)
        .min(MAX_MEETING_SAMPLES.saturating_sub(forwarded))
}

const RESAMPLER_FILTER_TAPS: usize = 255;
const RESAMPLER_CUTOFF_GUARD: f64 = 0.90;

/// Stateful sample-rate conversion for independently delivered capture streams.
///
/// Downsampling uses a windowed-sinc low-pass filter before selecting output
/// samples. Both the filter history and the bounded phase accumulator survive
/// callback boundaries, so splitting the same input into differently sized
/// capture buffers does not change either its samples or its eventual length.
pub(crate) struct StreamingResampler {
    output_rate: f64,
    input_rate: Option<f64>,
    phase: f64,
    coefficients: Vec<f32>,
    history: Vec<f32>,
    history_cursor: usize,
}

impl StreamingResampler {
    pub(crate) fn new(output_rate: f64) -> Self {
        Self {
            output_rate,
            input_rate: None,
            phase: 0.0,
            coefficients: Vec::new(),
            history: Vec::new(),
            history_cursor: 0,
        }
    }

    pub(crate) fn process(&mut self, input: &[f32], input_rate: f64) -> Vec<f32> {
        if !input_rate.is_finite()
            || input_rate <= 0.0
            || !self.output_rate.is_finite()
            || self.output_rate <= 0.0
        {
            self.clear();
            return Vec::new();
        }

        if self.input_rate != Some(input_rate) {
            self.configure(input_rate);
        }
        if input.is_empty() {
            return Vec::new();
        }
        if input_rate == self.output_rate {
            return input.to_vec();
        }

        let estimated_len =
            ((self.phase + input.len() as f64 * self.output_rate) / input_rate).floor() as usize;
        let mut output = Vec::with_capacity(estimated_len);
        for &sample in input {
            self.history[self.history_cursor] = sample;
            self.history_cursor = (self.history_cursor + 1) % self.history.len();
            self.phase += self.output_rate;

            while self.phase >= input_rate {
                let overshoot = self.phase - input_rate;
                let current = self.filtered_sample(0);
                if overshoot == 0.0 {
                    output.push(current);
                } else {
                    let fraction = (1.0 - overshoot / self.output_rate).clamp(0.0, 1.0) as f32;
                    let previous = self.filtered_sample(1);
                    output.push(previous + (current - previous) * fraction);
                }
                self.phase -= input_rate;
            }
        }
        output
    }

    fn configure(&mut self, input_rate: f64) {
        self.input_rate = Some(input_rate);
        self.phase = 0.0;
        self.coefficients = if input_rate > self.output_rate {
            low_pass_coefficients(input_rate, self.output_rate)
        } else {
            vec![1.0]
        };
        // One extra slot lets fractional output positions interpolate the
        // current and previous filtered input without losing the oldest tap.
        self.history = vec![0.0; self.coefficients.len() + 1];
        self.history_cursor = 0;
    }

    fn clear(&mut self) {
        self.input_rate = None;
        self.phase = 0.0;
        self.coefficients.clear();
        self.history.clear();
        self.history_cursor = 0;
    }

    fn filtered_sample(&self, delay: usize) -> f32 {
        let history_len = self.history.len();
        self.coefficients
            .iter()
            .enumerate()
            .map(|(lag, coefficient)| {
                let index = (self.history_cursor + history_len - 1 - delay - lag) % history_len;
                coefficient * self.history[index]
            })
            .sum()
    }
}

fn low_pass_coefficients(input_rate: f64, output_rate: f64) -> Vec<f32> {
    let cutoff = 0.5 * output_rate / input_rate * RESAMPLER_CUTOFF_GUARD;
    let center = (RESAMPLER_FILTER_TAPS - 1) as f64 / 2.0;
    let mut coefficients = (0..RESAMPLER_FILTER_TAPS)
        .map(|index| {
            let index = index as f64;
            let offset = index - center;
            let sinc_argument = 2.0 * cutoff * offset;
            let sinc = if sinc_argument.abs() < f64::EPSILON {
                1.0
            } else {
                (std::f64::consts::PI * sinc_argument).sin()
                    / (std::f64::consts::PI * sinc_argument)
            };
            let window = 0.42
                - 0.5
                    * (2.0 * std::f64::consts::PI * index / (RESAMPLER_FILTER_TAPS - 1) as f64)
                        .cos()
                + 0.08
                    * (4.0 * std::f64::consts::PI * index / (RESAMPLER_FILTER_TAPS - 1) as f64)
                        .cos();
            2.0 * cutoff * sinc * window
        })
        .collect::<Vec<_>>();
    let gain = coefficients.iter().sum::<f64>();
    for coefficient in &mut coefficients {
        *coefficient /= gain;
    }
    coefficients
        .into_iter()
        .map(|coefficient| coefficient as f32)
        .collect()
}

fn mix_audio(
    system: &[f32],
    microphone: &[f32],
    length: usize,
    microphone_only: bool,
    system_only: bool,
) -> Vec<f32> {
    (0..length)
        .map(|index| {
            let mic = microphone.get(index).copied().unwrap_or(0.0);
            if microphone_only {
                return mic.clamp(-1.0, 1.0);
            }
            let desktop = system.get(index).copied().unwrap_or(0.0);
            if system_only {
                return desktop.clamp(-1.0, 1.0);
            }
            (desktop * 0.65 + mic * 0.82).tanh()
        })
        .collect()
}

pub(crate) fn required_microphone_stalled(
    system_only: bool,
    capture_ready_at: Option<Instant>,
    last_microphone: Instant,
) -> bool {
    !system_only
        && capture_ready_at
            .map(|ready| ready.elapsed() >= Duration::from_secs(3))
            .unwrap_or(false)
        && last_microphone.elapsed() >= Duration::from_secs(3)
}

#[derive(Default)]
pub(crate) struct TimestampMixer {
    origin_seconds: Option<f64>,
    cursor: usize,
    system: Vec<f32>,
    microphone: Vec<f32>,
}

impl TimestampMixer {
    pub(crate) fn push(&mut self, source: AudioSource, presentation_seconds: f64, samples: &[f32]) {
        if samples.is_empty() {
            return;
        }
        let origin = *self.origin_seconds.get_or_insert(presentation_seconds);
        let delta_seconds = presentation_seconds - origin;
        let mut skip = 0usize;
        let signed_offset = (delta_seconds * SAMPLE_RATE as f64).round() as i64;
        let source_end = match source {
            AudioSource::System => self.system.len(),
            AudioSource::Microphone => self.microphone.len(),
        };
        let latest_end = self.system.len().max(self.microphone.len());
        let expected_offset = if source_end > 0 {
            source_end
        } else {
            latest_end.saturating_sub(samples.len()).max(self.cursor)
        };
        let skew_samples = signed_offset.abs_diff(expected_offset as i64);
        let offset =
            if skew_samples > (MAX_ALIGNMENT_SKEW_SECONDS * SAMPLE_RATE as f64).round() as u64 {
                expected_offset
            } else if signed_offset < 0 && self.cursor == 0 {
                let shift = (-signed_offset) as usize;
                prepend_silence(&mut self.system, shift);
                prepend_silence(&mut self.microphone, shift);
                self.origin_seconds = Some(presentation_seconds);
                0
            } else if signed_offset < self.cursor as i64 {
                skip = (self.cursor as i64 - signed_offset).max(0) as usize;
                if skip >= samples.len() {
                    return;
                }
                self.cursor
            } else {
                signed_offset as usize
            };
        let samples = &samples[skip..];
        let target = match source {
            AudioSource::System => &mut self.system,
            AudioSource::Microphone => &mut self.microphone,
        };
        if target.len() < offset {
            target.resize(offset, 0.0);
        }
        if target.len() < offset + samples.len() {
            target.resize(offset + samples.len(), 0.0);
        }
        target[offset..offset + samples.len()].copy_from_slice(samples);
    }

    pub(crate) fn microphone_available(&self) -> usize {
        self.microphone.len().saturating_sub(self.cursor)
    }

    pub(crate) fn system_available(&self) -> usize {
        self.system.len().saturating_sub(self.cursor)
    }

    pub(crate) fn remaining(&self) -> usize {
        self.system
            .len()
            .max(self.microphone.len())
            .saturating_sub(self.cursor)
    }

    pub(crate) fn take(
        &mut self,
        length: usize,
        microphone_only: bool,
        system_only: bool,
    ) -> Vec<f32> {
        let end = self.cursor.saturating_add(length);
        let system = self
            .system
            .get(self.cursor..end)
            .unwrap_or_else(|| self.system.get(self.cursor..).unwrap_or(&[]));
        let microphone = self
            .microphone
            .get(self.cursor..end)
            .unwrap_or_else(|| self.microphone.get(self.cursor..).unwrap_or(&[]));
        let mixed = mix_audio(system, microphone, length, microphone_only, system_only);
        self.cursor = end;
        self.compact();
        mixed
    }

    fn compact(&mut self) {
        if self.cursor < AUDIO_FRAME_SAMPLES * 10 {
            return;
        }
        let consumed = self.cursor;
        let system_drain = consumed.min(self.system.len());
        let microphone_drain = consumed.min(self.microphone.len());
        self.system.drain(..system_drain);
        self.microphone.drain(..microphone_drain);
        if let Some(origin) = self.origin_seconds.as_mut() {
            *origin += consumed as f64 / SAMPLE_RATE as f64;
        }
        self.cursor = 0;
    }
}

fn prepend_silence(target: &mut Vec<f32>, length: usize) {
    if length == 0 || target.is_empty() {
        return;
    }
    let mut shifted = Vec::with_capacity(length + target.len());
    shifted.resize(length, 0.0);
    shifted.extend_from_slice(target);
    *target = shifted;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(frequency: f64, sample_rate: f64, length: usize) -> Vec<f32> {
        (0..length)
            .map(|index| {
                (2.0 * std::f64::consts::PI * frequency * index as f64 / sample_rate).sin() as f32
            })
            .collect()
    }

    fn rms(samples: &[f32]) -> f64 {
        (samples
            .iter()
            .map(|sample| f64::from(*sample).powi(2))
            .sum::<f64>()
            / samples.len() as f64)
            .sqrt()
    }

    #[test]
    fn one_second_at_forty_eight_kilohertz_has_exact_output_length() {
        let input = vec![0.0; 48_000];
        let mut resampler = StreamingResampler::new(16_000.0);
        assert_eq!(resampler.process(&input, 48_000.0).len(), 16_000);
    }

    #[test]
    fn preserves_one_kilohertz_tone_when_downsampling() {
        let input = tone(1_000.0, 48_000.0, 48_000);
        let mut resampler = StreamingResampler::new(16_000.0);
        let output = resampler.process(&input, 48_000.0);
        let settled = &output[RESAMPLER_FILTER_TAPS..];
        let amplitude_ratio = rms(settled) / rms(&input[RESAMPLER_FILTER_TAPS * 3..]);
        assert!(
            (0.98..=1.02).contains(&amplitude_ratio),
            "1 kHz amplitude ratio was {amplitude_ratio}"
        );
    }

    #[test]
    fn suppresses_twelve_kilohertz_alias_before_downsampling() {
        let input = tone(12_000.0, 48_000.0, 48_000);
        let naive = input.iter().skip(2).step_by(3).copied().collect::<Vec<_>>();
        let mut resampler = StreamingResampler::new(16_000.0);
        let filtered = resampler.process(&input, 48_000.0);
        let naive_rms = rms(&naive[RESAMPLER_FILTER_TAPS..]);
        let filtered_rms = rms(&filtered[RESAMPLER_FILTER_TAPS..]);
        assert!(
            filtered_rms < naive_rms * 0.02,
            "12 kHz RMS was {filtered_rms}, versus naive decimation RMS {naive_rms}"
        );
    }

    #[test]
    fn callback_boundaries_do_not_change_resampled_audio() {
        let low = tone(1_000.0, 48_000.0, 48_000);
        let high = tone(12_000.0, 48_000.0, 48_000);
        let input = low
            .iter()
            .zip(high.iter())
            .map(|(low, high)| low * 0.8 + high * 0.2)
            .collect::<Vec<_>>();

        let mut whole_resampler = StreamingResampler::new(16_000.0);
        let whole = whole_resampler.process(&input, 48_000.0);

        let callback_sizes = [1, 17, 480, 113, 2_047, 7, 4_096];
        let mut split_resampler = StreamingResampler::new(16_000.0);
        let mut split = Vec::new();
        let mut start = 0;
        let mut callback_index = 0;
        while start < input.len() {
            let end =
                (start + callback_sizes[callback_index % callback_sizes.len()]).min(input.len());
            split.extend(split_resampler.process(&input[start..end], 48_000.0));
            start = end;
            callback_index += 1;
        }

        assert_eq!(split, whole);
    }

    #[test]
    fn preserves_samples_at_the_target_rate_and_resets_after_rate_changes() {
        let direct = vec![-0.75, -0.25, 0.0, 0.25, 0.75];
        let mut resampler = StreamingResampler::new(16_000.0);
        let _ = resampler.process(&tone(1_000.0, 48_000.0, 480), 48_000.0);
        assert_eq!(resampler.process(&direct, 16_000.0), direct);

        let silence = vec![0.0; 480];
        let after_rate_change = resampler.process(&silence, 48_000.0);
        let mut fresh = StreamingResampler::new(16_000.0);
        assert_eq!(after_rate_change, fresh.process(&silence, 48_000.0));
    }

    #[test]
    fn caps_capture_at_exactly_six_hours() {
        assert_eq!(
            bounded_audio_take(AUDIO_FRAME_SAMPLES, MAX_MEETING_SAMPLES),
            0
        );
        assert_eq!(
            bounded_audio_take(AUDIO_FRAME_SAMPLES, MAX_MEETING_SAMPLES - 137),
            137
        );
        assert_eq!(MAX_MEETING_SAMPLES / SAMPLE_RATE as usize, 21_600);
    }

    #[test]
    fn caps_a_buffered_manual_stop_tail_at_the_same_six_hour_boundary() {
        let mut forwarded = MAX_MEETING_SAMPLES - 137;
        let mut buffered = AUDIO_FRAME_SAMPLES * 2;
        while buffered > 0 {
            let take = bounded_audio_take(buffered, forwarded);
            if take == 0 {
                break;
            }
            forwarded += take;
            buffered -= take;
        }
        assert_eq!(forwarded, MAX_MEETING_SAMPLES);
        assert_eq!(buffered, AUDIO_FRAME_SAMPLES * 2 - 137);
    }

    #[test]
    fn mixer_keeps_samples_bounded() {
        let mixed = mix_audio(&vec![1.0; 100], &vec![1.0; 100], 100, false, false);
        assert!(mixed.iter().all(|sample| sample.abs() <= 1.0));
    }

    #[test]
    fn system_only_mixer_is_transparent_and_bounded() {
        let system = [-1.5, -0.5, 0.0, 0.5, 1.5];
        let mixed = mix_audio(&system, &[], system.len(), false, true);
        assert_eq!(mixed, vec![-1.0, -0.5, 0.0, 0.5, 1.0]);
    }

    #[test]
    fn combined_mixer_keeps_source_specific_weights() {
        let system = [0.5];
        let microphone = [0.25];
        let mixed = mix_audio(&system, &microphone, 1, false, false);
        assert!((mixed[0] - (0.5_f32 * 0.65 + 0.25 * 0.82).tanh()).abs() < f32::EPSILON);
    }

    #[test]
    fn aligns_inputs_using_capture_timestamps() {
        let mut timeline = TimestampMixer::default();
        timeline.push(AudioSource::Microphone, 10.0, &vec![0.5; 16_000]);
        timeline.push(AudioSource::System, 10.5, &vec![0.25; 8_000]);
        let mixed = timeline.take(16_000, false, false);
        assert!((mixed[1_000] - (0.5_f32 * 0.82).tanh()).abs() < 0.001);
        assert!((mixed[12_000] - (0.25_f32 * 0.65 + 0.5 * 0.82).tanh()).abs() < 0.001);
    }

    #[test]
    fn rebases_when_the_second_callback_has_an_earlier_timestamp() {
        let mut timeline = TimestampMixer::default();
        timeline.push(AudioSource::Microphone, 10.1, &vec![0.5; 1_600]);
        timeline.push(AudioSource::System, 10.0, &vec![0.25; 3_200]);
        let mixed = timeline.take(3_200, false, false);
        assert!((mixed[800] - (0.25_f32 * 0.65).tanh()).abs() < 0.001);
        assert!((mixed[2_000] - (0.25_f32 * 0.65 + 0.5 * 0.82).tanh()).abs() < 0.001);
    }

    #[test]
    fn mismatched_clock_epochs_do_not_allocate_a_huge_timeline() {
        let mut timeline = TimestampMixer::default();
        timeline.push(AudioSource::System, 0.0, &vec![0.25; 3_200]);
        timeline.push(AudioSource::Microphone, 100_000.0, &vec![0.5; 3_200]);
        assert_eq!(timeline.system.len(), 3_200);
        assert_eq!(timeline.microphone.len(), 3_200);
        assert_eq!(timeline.remaining(), 3_200);
    }

    #[test]
    fn continuous_timestamps_beyond_skew_window_are_not_overwritten() {
        let mut timeline = TimestampMixer::default();
        for index in 0..50 {
            timeline.push(
                AudioSource::System,
                index as f64 * 0.2,
                &vec![index as f32; 3_200],
            );
        }
        assert_eq!(timeline.system.len(), 160_000);
        assert_eq!(timeline.remaining(), 160_000);
        assert_eq!(timeline.system[156_800], 49.0);
    }

    #[test]
    fn system_audio_is_available_without_microphone_samples() {
        let mut timeline = TimestampMixer::default();
        timeline.push(AudioSource::System, 10.0, &vec![0.25; AUDIO_FRAME_SAMPLES]);
        assert_eq!(timeline.system_available(), AUDIO_FRAME_SAMPLES);
        assert_eq!(timeline.microphone_available(), 0);
        let mixed = timeline.take(AUDIO_FRAME_SAMPLES, false, true);
        assert!(
            mixed
                .iter()
                .all(|sample| (*sample - 0.25).abs() < f32::EPSILON)
        );
    }

    #[test]
    fn microphone_required_modes_do_not_depend_on_system_audio_for_the_watchdog() {
        let capture_ready = Instant::now() - Duration::from_secs(4);
        let last_microphone = Instant::now() - Duration::from_secs(4);
        assert!(required_microphone_stalled(
            false,
            Some(capture_ready),
            last_microphone,
        ));
        assert!(!required_microphone_stalled(
            true,
            Some(capture_ready),
            last_microphone,
        ));
    }
}
