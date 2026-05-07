#![allow(dead_code)]

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::vault::{should_ignore_path, to_relative_path};

use super::db::{FILE_KIND_MARKDOWN, SyncFileInput, file_id_for_normalized_path};
use super::errors::{SyncError, SyncResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScannedFile {
    pub file_id: String,
    pub path: String,
    pub normalized_path: String,
    pub plaintext_hash: String,
    pub size_bytes: i64,
    pub mtime_ms: i64,
    pub plaintext: Vec<u8>,
}

impl ScannedFile {
    pub fn file_input(&self) -> SyncFileInput {
        SyncFileInput {
            path: self.path.clone(),
            normalized_path: self.normalized_path.clone(),
            kind: FILE_KIND_MARKDOWN.into(),
            plaintext_hash: Some(self.plaintext_hash.clone()),
            size_bytes: Some(self.size_bytes),
            mtime_ms: Some(self.mtime_ms),
        }
    }
}

pub fn scan_vault(root: &Path) -> SyncResult<Vec<ScannedFile>> {
    let metadata = fs::metadata(root)
        .map_err(|error| SyncError::Storage(format!("failed to read vault root: {error}")))?;
    if !metadata.is_dir() {
        return Err(SyncError::InvalidArgument(format!(
            "vault root is not a directory: {}",
            root.display()
        )));
    }

    let mut files = Vec::new();
    scan_dir(root, root, &mut files)?;
    files.sort_by(|left, right| left.normalized_path.cmp(&right.normalized_path));
    validate_unique_normalized_paths(&files)?;
    Ok(files)
}

pub fn normalize_vault_relative_path(relative_path: &str) -> SyncResult<String> {
    let normalized_separators = relative_path.replace('\\', "/");
    if normalized_separators.is_empty() || normalized_separators.starts_with('/') {
        return Err(SyncError::InvalidArgument(
            "sync path must be vault-relative".into(),
        ));
    }

    let mut components = Vec::new();
    for segment in normalized_separators.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                return Err(SyncError::InvalidArgument(
                    "sync path traversal is not allowed".into(),
                ));
            }
            value => components.push(value.to_lowercase()),
        }
    }

    if components.is_empty() {
        return Err(SyncError::InvalidArgument(
            "sync path must include a file name".into(),
        ));
    }

    Ok(components.join("/"))
}

pub fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
}

fn scan_dir(root: &Path, dir: &Path, files: &mut Vec<ScannedFile>) -> SyncResult<()> {
    let entries = fs::read_dir(dir).map_err(|error| {
        SyncError::Storage(format!(
            "failed to read sync directory {}: {error}",
            dir.display()
        ))
    })?;

    for entry in entries {
        let entry = entry.map_err(|error| {
            SyncError::Storage(format!(
                "failed to read sync directory entry {}: {error}",
                dir.display()
            ))
        })?;
        let path = entry.path();
        let relative = path.strip_prefix(root).unwrap_or(&path);
        if should_ignore_path(relative) {
            continue;
        }

        let file_type = entry.file_type().map_err(|error| {
            SyncError::Storage(format!(
                "failed to read sync file type {}: {error}",
                path.display()
            ))
        })?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            scan_dir(root, &path, files)?;
            continue;
        }
        if !file_type.is_file() || !is_markdown_path(&path) {
            continue;
        }

        files.push(scan_file(root, &path)?);
    }

    Ok(())
}

fn scan_file(root: &Path, path: &Path) -> SyncResult<ScannedFile> {
    let relative_path = to_relative_path(root, path);
    let normalized_path = normalize_vault_relative_path(&relative_path)?;
    let metadata = fs::metadata(path).map_err(|error| {
        SyncError::Storage(format!(
            "failed to read sync file metadata {}: {error}",
            path.display()
        ))
    })?;
    let plaintext = fs::read(path).map_err(|error| {
        SyncError::Storage(format!(
            "failed to read sync file {}: {error}",
            path.display()
        ))
    })?;
    let size_bytes = i64::try_from(plaintext.len()).map_err(|_| {
        SyncError::InvalidArgument(format!("sync file is too large: {}", path.display()))
    })?;
    let mtime_ms = modified_ms(&metadata)?;
    let plaintext_hash = blake3::hash(&plaintext).to_hex().to_string();
    let file_id = file_id_for_normalized_path(&normalized_path);

    Ok(ScannedFile {
        file_id,
        path: relative_path,
        normalized_path,
        plaintext_hash,
        size_bytes,
        mtime_ms,
        plaintext,
    })
}

fn modified_ms(metadata: &fs::Metadata) -> SyncResult<i64> {
    let modified = metadata.modified().map_err(|error| {
        SyncError::Storage(format!("failed to read sync file modified time: {error}"))
    })?;
    let duration = modified.duration_since(UNIX_EPOCH).unwrap_or_default();
    Ok(duration.as_millis().min(i64::MAX as u128) as i64)
}

fn validate_unique_normalized_paths(files: &[ScannedFile]) -> SyncResult<()> {
    let mut seen = BTreeSet::new();
    for file in files {
        if !seen.insert(file.normalized_path.as_str()) {
            return Err(SyncError::InvalidArgument(format!(
                "duplicate normalized sync path: {}",
                file.normalized_path
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    #[test]
    fn normalize_path_lowercases_separators_and_rejects_traversal() {
        assert_eq!(
            normalize_vault_relative_path("Notes\\Project/Plan.MD").unwrap(),
            "notes/project/plan.md"
        );

        let err = normalize_vault_relative_path("../outside.md").unwrap_err();
        assert!(
            matches!(err, SyncError::InvalidArgument(message) if message.contains("traversal"))
        );
    }

    #[test]
    fn scanner_ignores_hidden_temp_symlink_and_non_markdown() {
        let root = temp_vault("scanner-ignore");
        write_file(&root.join("notes").join("Plan.md"), b"# Plan");
        write_file(&root.join(".hidden.md"), b"hidden");
        write_file(&root.join("notes").join("scratch.tmp"), b"tmp");
        write_file(&root.join("notes").join("draft.md~"), b"tmp");
        write_file(&root.join("notes").join("image.png"), b"png");

        #[cfg(unix)]
        {
            symlink(root.join("notes").join("Plan.md"), root.join("linked.md")).unwrap();
        }

        let files = scan_vault(&root).unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "notes/Plan.md");
        assert_eq!(files[0].normalized_path, "notes/plan.md");
        assert_eq!(files[0].plaintext, b"# Plan");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scanner_rejects_normalized_path_collisions() {
        let files = vec![
            scanned_file("A/Plan.md", "a/plan.md"),
            scanned_file("a/Plan.md", "a/plan.md"),
        ];
        let err = validate_unique_normalized_paths(&files).unwrap_err();

        assert!(
            matches!(err, SyncError::InvalidArgument(message) if message.contains("duplicate normalized"))
        );
    }

    fn scanned_file(path: &str, normalized_path: &str) -> ScannedFile {
        ScannedFile {
            file_id: file_id_for_normalized_path(normalized_path),
            path: path.into(),
            normalized_path: normalized_path.into(),
            plaintext_hash: "hash".into(),
            size_bytes: 1,
            mtime_ms: 1,
            plaintext: vec![1],
        }
    }

    fn temp_vault(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("kuku-sync-{name}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_file(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut file = fs::File::create(path).unwrap();
        file.write_all(bytes).unwrap();
    }
}
