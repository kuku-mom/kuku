#![allow(dead_code)]

use std::path::{Component, Path, PathBuf};

use super::errors::{SyncError, SyncResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MarkdownMergeOutcome {
    Merged(Vec<u8>),
    Conflict,
}

pub fn merge_markdown(
    base: &[u8],
    local: &[u8],
    remote: &[u8],
) -> SyncResult<MarkdownMergeOutcome> {
    if local == remote {
        return Ok(MarkdownMergeOutcome::Merged(local.to_vec()));
    }
    if base == local {
        return Ok(MarkdownMergeOutcome::Merged(remote.to_vec()));
    }
    if base == remote {
        return Ok(MarkdownMergeOutcome::Merged(local.to_vec()));
    }

    let base = utf8_or_conflict(base)?;
    let local = utf8_or_conflict(local)?;
    let remote = utf8_or_conflict(remote)?;
    let base_lines = split_lines(base);
    let local_lines = split_lines(local);
    let remote_lines = split_lines(remote);
    let max_len = base_lines
        .len()
        .max(local_lines.len())
        .max(remote_lines.len());
    let mut merged = String::new();

    for index in 0..max_len {
        let base_line = base_lines.get(index).copied().unwrap_or("");
        let local_line = local_lines.get(index).copied().unwrap_or("");
        let remote_line = remote_lines.get(index).copied().unwrap_or("");
        if local_line == remote_line {
            merged.push_str(local_line);
        } else if local_line == base_line {
            merged.push_str(remote_line);
        } else if remote_line == base_line {
            merged.push_str(local_line);
        } else {
            return Ok(MarkdownMergeOutcome::Conflict);
        }
    }

    Ok(MarkdownMergeOutcome::Merged(merged.into_bytes()))
}

pub fn conflict_copy_relative_path(
    original_path: &str,
    created_at_ms: i64,
    mut exists: impl FnMut(&str) -> bool,
) -> SyncResult<String> {
    let original = validate_relative_path(original_path)?;
    let timestamp = timestamp_utc(created_at_ms);
    let parent = original.parent().map(Path::to_path_buf).unwrap_or_default();
    let stem = original
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| SyncError::InvalidArgument("conflict source path is invalid".into()))?;
    let extension = original.extension().and_then(|value| value.to_str());

    for suffix in 1.. {
        let file_name = match (suffix, extension) {
            (1, Some(extension)) => format!("{stem}.conflict-{timestamp}.{extension}"),
            (1, None) => format!("{stem}.conflict-{timestamp}"),
            (_, Some(extension)) => format!("{stem}.conflict-{timestamp}-{suffix}.{extension}"),
            (_, None) => format!("{stem}.conflict-{timestamp}-{suffix}"),
        };
        let candidate = parent.join(file_name);
        let candidate = path_to_slash_string(&candidate)?;
        if !exists(&candidate) {
            return Ok(candidate);
        }
    }

    unreachable!("unbounded suffix search should always return")
}

fn utf8_or_conflict(bytes: &[u8]) -> SyncResult<&str> {
    match std::str::from_utf8(bytes) {
        Ok(value) => Ok(value),
        Err(_) => Err(SyncError::InvalidArgument(
            "markdown merge requires utf-8 content".into(),
        )),
    }
}

fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        Vec::new()
    } else {
        text.split_inclusive('\n').collect()
    }
}

fn validate_relative_path(path: &str) -> SyncResult<PathBuf> {
    if path.trim().is_empty() {
        return Err(SyncError::InvalidArgument(
            "conflict source path is required".into(),
        ));
    }
    let mut out = PathBuf::new();
    for component in Path::new(path).components() {
        match component {
            Component::Normal(value) => out.push(value),
            Component::CurDir => {}
            _ => {
                return Err(SyncError::InvalidArgument(
                    "conflict source path must be vault-relative".into(),
                ));
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Err(SyncError::InvalidArgument(
            "conflict source path is required".into(),
        ));
    }
    Ok(out)
}

fn path_to_slash_string(path: &Path) -> SyncResult<String> {
    path.to_str()
        .map(|value| value.replace('\\', "/"))
        .ok_or_else(|| SyncError::InvalidArgument("conflict path is not utf-8".into()))
}

fn timestamp_utc(ms: i64) -> String {
    let seconds = ms.div_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}")
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_merge_keeps_non_overlapping_line_edits() {
        let result = merge_markdown(b"a\nb\n", b"A\nb\n", b"a\nB\n").unwrap();

        assert_eq!(result, MarkdownMergeOutcome::Merged(b"A\nB\n".to_vec()));
    }

    #[test]
    fn markdown_merge_detects_same_line_conflict() {
        let result = merge_markdown(b"a\n", b"local\n", b"remote\n").unwrap();

        assert_eq!(result, MarkdownMergeOutcome::Conflict);
    }

    #[test]
    fn conflict_copy_path_uses_timestamp_and_suffix() {
        let mut occupied = vec!["notes/a.conflict-19700101-000001.md".to_string()];
        let path = conflict_copy_relative_path("notes/a.md", 1_000, |candidate| {
            occupied.contains(&candidate.to_string())
        })
        .unwrap();

        assert_eq!(path, "notes/a.conflict-19700101-000001-2.md");
        occupied.push(path);
        let next = conflict_copy_relative_path("notes/a.md", 1_000, |candidate| {
            occupied.contains(&candidate.to_string())
        })
        .unwrap();
        assert_eq!(next, "notes/a.conflict-19700101-000001-3.md");
    }
}
