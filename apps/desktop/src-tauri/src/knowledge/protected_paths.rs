use std::path::{Path, PathBuf};

use icu_normalizer::ComposingNormalizerBorrowed;

const PROTECTED_PREFIXES: [&str; 2] = ["Knowledge/memory", "Knowledge/decisions"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtectedPathError {
    pub message: String,
}

impl ProtectedPathError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

pub async fn guard_ai_raw_mutation_path(
    vault_root: &Path,
    value: &str,
) -> Result<String, ProtectedPathError> {
    let normalized = normalize_ai_raw_mutation_path(value)?;
    if is_protected_relative_path(&normalized) {
        return Err(protected_path_error(&normalized));
    }

    if resolved_path_is_protected(vault_root, &normalized).await? {
        return Err(protected_path_error(&normalized));
    }

    Ok(normalized)
}

pub fn normalize_ai_raw_mutation_path(value: &str) -> Result<String, ProtectedPathError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(ProtectedPathError::new("Path is empty"));
    }
    if trimmed.starts_with('/') || trimmed.starts_with('\\') || has_windows_drive_prefix(trimmed) {
        return Err(ProtectedPathError::new("Absolute paths are not allowed"));
    }
    if trimmed.chars().any(|ch| ch == '\0' || ch.is_control()) {
        return Err(ProtectedPathError::new(
            "Path contains NUL or control characters",
        ));
    }

    let normalizer = ComposingNormalizerBorrowed::new_nfc();
    let mut segments = Vec::new();
    for raw_segment in trimmed.split(['/', '\\']) {
        if raw_segment.is_empty() {
            continue;
        }
        let decoded = percent_decode_segment(raw_segment)?;
        let segment = normalizer.normalize(&decoded).to_string();
        match segment.as_str() {
            "." => {}
            ".." => {
                return Err(ProtectedPathError::new("Path traversal is not allowed"));
            }
            _ => segments.push(segment),
        }
    }

    if segments.is_empty() {
        return Err(ProtectedPathError::new("Path is empty"));
    }
    Ok(segments.join("/"))
}

fn is_protected_relative_path(path: &str) -> bool {
    let key = path.to_lowercase();
    PROTECTED_PREFIXES.iter().any(|prefix| {
        let prefix = prefix.to_lowercase();
        key == prefix || key.starts_with(&format!("{prefix}/"))
    })
}

async fn resolved_path_is_protected(
    vault_root: &Path,
    normalized_path: &str,
) -> Result<bool, ProtectedPathError> {
    let protected_keys = protected_absolute_keys(vault_root).await;
    let resolved_key = resolved_absolute_key(vault_root, normalized_path).await?;
    Ok(protected_keys
        .iter()
        .any(|protected| path_key_is_under(&resolved_key, protected)))
}

async fn protected_absolute_keys(vault_root: &Path) -> Vec<String> {
    let mut keys = Vec::new();
    for prefix in PROTECTED_PREFIXES {
        let lexical = vault_root.join(prefix);
        keys.push(path_key(&lexical));
        if let Ok(canonical) = tokio::fs::canonicalize(&lexical).await {
            keys.push(path_key(&canonical));
        }
    }
    keys.sort();
    keys.dedup();
    keys
}

async fn resolved_absolute_key(
    vault_root: &Path,
    normalized_path: &str,
) -> Result<String, ProtectedPathError> {
    let mut current = tokio::fs::canonicalize(vault_root)
        .await
        .unwrap_or_else(|_| vault_root.to_path_buf());
    let segments = normalized_path.split('/').collect::<Vec<_>>();

    for (index, segment) in segments.iter().enumerate() {
        let next = current.join(segment);
        match tokio::fs::symlink_metadata(&next).await {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                current = resolve_symlink_target(&next).await?;
            }
            Ok(_) => {
                current = tokio::fs::canonicalize(&next)
                    .await
                    .unwrap_or_else(|_| next.clone());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                current = append_remaining(next, &segments[index + 1..]);
                break;
            }
            Err(error) => return Err(ProtectedPathError::new(error.to_string())),
        }
    }

    Ok(path_key(&current))
}

async fn resolve_symlink_target(path: &Path) -> Result<PathBuf, ProtectedPathError> {
    let target = tokio::fs::read_link(path)
        .await
        .map_err(|error| ProtectedPathError::new(error.to_string()))?;
    let absolute = if target.is_absolute() {
        target
    } else {
        path.parent().unwrap_or(Path::new("")).join(target)
    };
    tokio::fs::canonicalize(&absolute).await.map_err(|error| {
        ProtectedPathError::new(format!("Symlink target cannot be resolved: {error}"))
    })
}

fn append_remaining(mut path: PathBuf, remaining: &[&str]) -> PathBuf {
    for segment in remaining {
        path.push(segment);
    }
    path
}

fn path_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn path_key_is_under(path: &str, protected: &str) -> bool {
    path == protected || path.starts_with(&format!("{protected}/"))
}

fn protected_path_error(path: &str) -> ProtectedPathError {
    ProtectedPathError::new(format!(
        "AI raw file mutation is not allowed for protected Knowledge path: {path}"
    ))
}

fn has_windows_drive_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn percent_decode_segment(value: &str) -> Result<String, ProtectedPathError> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            output.push(bytes[index]);
            index += 1;
            continue;
        }
        if index + 2 >= bytes.len() {
            return Err(ProtectedPathError::new("Malformed percent encoding"));
        }
        let Some(high) = hex_value(bytes[index + 1]) else {
            return Err(ProtectedPathError::new("Malformed percent encoding"));
        };
        let Some(low) = hex_value(bytes[index + 2]) else {
            return Err(ProtectedPathError::new("Malformed percent encoding"));
        };
        let decoded = high << 4 | low;
        if decoded == b'/' || decoded == b'\\' {
            return Err(ProtectedPathError::new(
                "Percent-encoded separators are not allowed",
            ));
        }
        output.push(decoded);
        index += 3;
    }

    let decoded =
        String::from_utf8(output).map_err(|_| ProtectedPathError::new("Invalid UTF-8"))?;
    if contains_percent_encoding(&decoded) {
        return Err(ProtectedPathError::new(
            "Repeated percent encoding is not allowed",
        ));
    }
    Ok(decoded)
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn contains_percent_encoding(value: &str) -> bool {
    value.as_bytes().windows(3).any(|window| {
        window[0] == b'%' && hex_value(window[1]).is_some() && hex_value(window[2]).is_some()
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use tauri::async_runtime;

    use super::{guard_ai_raw_mutation_path, normalize_ai_raw_mutation_path};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn protected_path_guard_blocks_lexical_prefixes_case_and_dot_normalized() {
        let root = temp_vault();
        for path in [
            "Knowledge/memory/mem_auth.md",
            "knowledge/decisions/doc_auth.md",
            "Knowledge/./memory/mem_auth.md",
            "Knowledge/%6demory/mem_auth.md",
        ] {
            assert!(async_runtime::block_on(guard_ai_raw_mutation_path(&root, path)).is_err());
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn protected_path_guard_rejects_encoded_separator_and_repeated_percent_encoding() {
        assert!(normalize_ai_raw_mutation_path("C:/Knowledge/memory/mem_auth.md").is_err());
        assert!(normalize_ai_raw_mutation_path("Knowledge/%2fmemory/mem_auth.md").is_err());
        assert!(normalize_ai_raw_mutation_path("Knowledge/%256demory/mem_auth.md").is_err());
        assert!(normalize_ai_raw_mutation_path("Knowledge/%2e%2e/memory/mem_auth.md").is_err());
        assert!(normalize_ai_raw_mutation_path("../Knowledge/memory/mem_auth.md").is_err());
    }

    #[test]
    fn protected_path_guard_allows_unprotected_normalized_paths() {
        let root = temp_vault();
        let normalized = async_runtime::block_on(guard_ai_raw_mutation_path(
            &root,
            "Notes/./Cafe\u{0301}%20Notes.md",
        ))
        .unwrap();
        assert_eq!(normalized, "Notes/Café Notes.md");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[cfg(unix)]
    fn protected_path_guard_blocks_symlink_into_protected_path() {
        let root = temp_vault();
        fs::create_dir_all(root.join("Knowledge/memory")).unwrap();
        std::os::unix::fs::symlink(root.join("Knowledge/memory"), root.join("memory-link"))
            .unwrap();

        let error =
            async_runtime::block_on(guard_ai_raw_mutation_path(&root, "memory-link/mem_auth.md"))
                .unwrap_err();
        assert!(error.message.contains("protected Knowledge path"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[cfg(unix)]
    fn protected_path_guard_blocks_lexical_prefix_when_knowledge_is_symlink() {
        let root = temp_vault();
        let external = temp_vault();
        fs::create_dir_all(external.join("memory")).unwrap();
        std::os::unix::fs::symlink(&external, root.join("Knowledge")).unwrap();

        let error =
            async_runtime::block_on(guard_ai_raw_mutation_path(&root, "Knowledge/memory/new.md"))
                .unwrap_err();
        assert!(error.message.contains("protected Knowledge path"));

        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(external);
    }

    fn temp_vault() -> PathBuf {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let suffix = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("kuku-protected-path-test-{now}-{suffix}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
