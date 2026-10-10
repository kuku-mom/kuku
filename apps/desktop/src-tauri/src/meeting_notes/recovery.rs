//! Recovery-file inspection and repair.
//!
//! `hound` leaves zero RIFF/data lengths when a process exits before
//! finalization. Repairing only that exact header shape makes recordings from
//! interrupted sessions playable without touching unrelated WAV files.

use std::{
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};

pub(crate) fn repair_recovery_wav_headers(directory: &Path) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("wav") {
            continue;
        }
        if let Err(_error) = repair_incomplete_wav_header(&path) {
            #[cfg(debug_assertions)]
            eprintln!(
                "[meeting-recovery] could not inspect {}: {_error}",
                path.display()
            );
        }
    }
}

fn repair_incomplete_wav_header(path: &Path) -> Result<bool, String> {
    let file_len = fs::metadata(path).map_err(|error| error.to_string())?.len();
    if file_len <= 44 || file_len - 44 > u32::MAX as u64 {
        return Ok(false);
    }
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    let mut header = [0u8; 44];
    file.read_exact(&mut header)
        .map_err(|error| error.to_string())?;
    let is_hound_pcm = &header[0..4] == b"RIFF"
        && &header[8..12] == b"WAVE"
        && &header[12..16] == b"fmt "
        && &header[36..40] == b"data";
    let unfinished = header[4..8] == [0, 0, 0, 0] && header[40..44] == [0, 0, 0, 0];
    if !is_hound_pcm || !unfinished {
        return Ok(false);
    }
    let riff_len = (file_len - 8) as u32;
    let data_len = (file_len - 44) as u32;
    file.seek(SeekFrom::Start(4))
        .and_then(|_| file.write_all(&riff_len.to_le_bytes()))
        .and_then(|_| file.seek(SeekFrom::Start(40)).map(|_| ()))
        .and_then(|_| file.write_all(&data_len.to_le_bytes()))
        .and_then(|_| file.flush())
        .map_err(|error| error.to_string())?;
    #[cfg(debug_assertions)]
    eprintln!(
        "[meeting-recovery] repaired incomplete WAV header: {}",
        path.display(),
    );
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meeting_notes::audio::SAMPLE_RATE;
    use uuid::Uuid;

    #[test]
    fn repairs_pcm_wav_left_unfinalized_by_an_interrupted_exit() {
        let path =
            std::env::temp_dir().join(format!("kuku-meeting-wav-repair-{}.wav", Uuid::new_v4()));
        let mut bytes = Vec::from(
            &b"RIFF\0\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x80>\0\0\0}\0\0\x02\0\x10\0data\0\0\0\0"
                [..],
        );
        bytes.extend_from_slice(&[0u8; 320]);
        fs::write(&path, bytes).expect("write incomplete wav");

        assert!(repair_incomplete_wav_header(&path).expect("repair wav"));
        let reader = hound::WavReader::open(&path).expect("open repaired wav");
        assert_eq!(reader.spec().sample_rate, SAMPLE_RATE);
        assert_eq!(reader.duration(), 160);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn leaves_finalized_or_unrelated_files_untouched() {
        let path =
            std::env::temp_dir().join(format!("kuku-meeting-wav-valid-{}.wav", Uuid::new_v4()));
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&path, spec).expect("create wav");
        writer.write_sample(0_i16).expect("write sample");
        writer.finalize().expect("finalize wav");
        assert!(!repair_incomplete_wav_header(&path).expect("inspect wav"));
        let _ = fs::remove_file(path);
    }
}
