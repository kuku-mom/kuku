use std::path::Path;
use std::time::SystemTime;

use chrono::{DateTime, SecondsFormat, Utc};
use icu_normalizer::ComposingNormalizerBorrowed;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::knowledge::models::{
    KnowledgeIdPrefix, MemoryItem, MemoryStatus, SourceRange, SourceRef, SourceRefInput, WikiPage,
    WikiPageStatus, WikiPageType,
};

const MAX_ID_BODY_LEN: usize = 80;
const MAX_SLUG_LEN: usize = 80;
const MAX_SOURCE_PATH_CHARS: usize = 1024;
const MAX_TITLE_CHARS: usize = 160;
const MAX_SECTION_PATH_ENTRIES: usize = 16;
const MAX_SECTION_PATH_ENTRY_CHARS: usize = 120;
const MAX_WIKI_PATH_CHARS: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnowledgeModelError {
    pub field: String,
    pub message: String,
}

impl KnowledgeModelError {
    fn new(field: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            field: field.into(),
            message: message.into(),
        }
    }
}

pub fn sha256_checksum_bytes(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

pub async fn sha256_checksum_file(path: &Path) -> Result<String, std::io::Error> {
    let bytes = tokio::fs::read(path).await?;
    Ok(sha256_checksum_bytes(&bytes))
}

pub fn format_utc_timestamp(time: SystemTime) -> String {
    let datetime: DateTime<Utc> = time.into();
    datetime.to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub fn now_utc_timestamp() -> String {
    format_utc_timestamp(SystemTime::now())
}

pub fn format_path_timestamp(time: SystemTime) -> String {
    let datetime: DateTime<Utc> = time.into();
    datetime.format("%Y-%m-%dT%H%M%SZ").to_string()
}

pub fn is_valid_knowledge_id(value: &str) -> bool {
    let Some((prefix, body)) = value.split_once('_') else {
        return false;
    };
    if !matches!(
        prefix,
        "mem" | "wiki" | "prop" | "change" | "decision" | "doc"
    ) {
        return false;
    }
    valid_id_body(body)
}

pub fn make_knowledge_id(prefix: KnowledgeIdPrefix, seed: &str) -> String {
    let body = sanitize_id_body(seed);
    format!("{}_{}", prefix.as_str(), body)
}

pub fn make_collision_free_knowledge_id<F>(
    prefix: KnowledgeIdPrefix,
    seed: &str,
    mut exists: F,
) -> Result<String, KnowledgeModelError>
where
    F: FnMut(&str) -> bool,
{
    let base = sanitize_id_body(seed);
    for index in 1..=100 {
        let suffix = if index == 1 {
            String::new()
        } else {
            format!("_{index}")
        };
        let body = truncate_for_suffix(&base, &suffix, MAX_ID_BODY_LEN);
        let candidate = format!("{}_{}{}", prefix.as_str(), body, suffix);
        if !exists(&candidate) {
            return Ok(candidate);
        }
    }

    Err(KnowledgeModelError::new(
        "id",
        "No collision-free Knowledge id is available",
    ))
}

pub fn slugify_title(value: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;

    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            last_was_dash = false;
        } else if !last_was_dash && !slug.is_empty() {
            slug.push('-');
            last_was_dash = true;
        }
    }

    while slug.ends_with('-') {
        slug.pop();
    }

    if slug.is_empty() {
        slug.push_str("memory-proposal");
    }

    truncate_chars(&slug, MAX_SLUG_LEN)
}

pub fn validate_safe_vault_relative_path(
    value: &str,
    field: &str,
) -> Result<String, KnowledgeModelError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(KnowledgeModelError::new(field, "Path is empty"));
    }
    if trimmed.starts_with('/') || trimmed.starts_with('\\') || has_windows_drive_prefix(trimmed) {
        return Err(KnowledgeModelError::new(
            field,
            "Absolute paths are not allowed",
        ));
    }
    if trimmed.chars().any(|ch| ch == '\0' || ch.is_control()) {
        return Err(KnowledgeModelError::new(
            field,
            "Path contains NUL or control characters",
        ));
    }

    let normalizer = ComposingNormalizerBorrowed::new_nfc();
    let mut normalized_segments = Vec::new();
    for raw_segment in trimmed.split(['/', '\\']) {
        if raw_segment.is_empty() {
            return Err(KnowledgeModelError::new(
                field,
                "Path contains an empty segment",
            ));
        }

        let decoded = percent_decode_segment(raw_segment, field)?;
        let segment = normalizer.normalize(&decoded).to_string();
        if segment == "." || segment == ".." {
            return Err(KnowledgeModelError::new(
                field,
                "Path contains a dot segment",
            ));
        }
        if is_reserved_filename(&segment) {
            return Err(KnowledgeModelError::new(
                field,
                format!("Reserved filename is not allowed: {segment}"),
            ));
        }
        if segment.chars().any(|ch| ch == '\0' || ch.is_control()) {
            return Err(KnowledgeModelError::new(
                field,
                "Path contains NUL or control characters",
            ));
        }
        normalized_segments.push(segment);
    }

    Ok(normalized_segments.join("/"))
}

pub fn validate_wiki_page_path(value: &str, field: &str) -> Result<String, KnowledgeModelError> {
    let path = validate_safe_vault_relative_path(value, field)?;
    if path.chars().count() > MAX_WIKI_PATH_CHARS {
        return Err(KnowledgeModelError::new(field, "Path is too long"));
    }
    if !path.starts_with("Knowledge/wiki/") {
        return Err(KnowledgeModelError::new(
            field,
            "Wiki page path must be under Knowledge/wiki/",
        ));
    }
    if !path.ends_with(".md") {
        return Err(KnowledgeModelError::new(
            field,
            "Wiki page path must end with .md",
        ));
    }
    Ok(path)
}

pub fn normalize_source_ref(
    input: SourceRefInput,
    captured_at: &str,
) -> Result<SourceRef, KnowledgeModelError> {
    let path = validate_safe_vault_relative_path(&input.path, "source_refs.path")?;
    if path.chars().count() > MAX_SOURCE_PATH_CHARS {
        return Err(KnowledgeModelError::new(
            "source_refs.path",
            "Path is too long",
        ));
    }

    let title = optional_trimmed_limited(input.title, "source_refs.title", MAX_TITLE_CHARS)?;
    let section_path = normalize_section_path(input.section_path)?;
    validate_range(input.range.as_ref())?;
    if let Some(checksum) = input.checksum.as_deref() {
        validate_sha256_checksum(checksum, "source_refs.checksum")?;
    }

    Ok(SourceRef {
        path,
        title,
        section_path,
        range: input.range,
        checksum: input.checksum,
        captured_at: captured_at.to_string(),
    })
}

pub fn serialize_memory_item(item: &MemoryItem) -> Result<String, KnowledgeModelError> {
    validate_memory_item(item)?;

    let frontmatter = MemoryFrontmatter::from(item);
    let mut yaml = serde_yaml::to_string(&frontmatter)
        .map_err(|error| KnowledgeModelError::new("frontmatter", error.to_string()))?;
    if let Some(stripped) = yaml.strip_prefix("---\n") {
        yaml = stripped.to_string();
    }
    if !yaml.ends_with('\n') {
        yaml.push('\n');
    }

    let body = normalize_memory_body_for_serialization(&item.body);
    Ok(format!("---\n{yaml}---\n{body}"))
}

pub fn parse_memory_item(markdown: &str) -> Result<MemoryItem, KnowledgeModelError> {
    let (frontmatter, body) = split_frontmatter(markdown)?;
    let parsed: MemoryFrontmatter = serde_yaml::from_str(frontmatter)
        .map_err(|error| KnowledgeModelError::new("frontmatter", error.to_string()))?;
    let item = parsed.into_memory_item(body.to_string());
    validate_memory_item(&item)?;
    Ok(item)
}

pub fn serialize_wiki_page(page: &WikiPage) -> Result<String, KnowledgeModelError> {
    validate_wiki_page(page)?;

    let frontmatter = WikiFrontmatter::from(page);
    let mut yaml = serde_yaml::to_string(&frontmatter)
        .map_err(|error| KnowledgeModelError::new("frontmatter", error.to_string()))?;
    if let Some(stripped) = yaml.strip_prefix("---\n") {
        yaml = stripped.to_string();
    }
    if !yaml.ends_with('\n') {
        yaml.push('\n');
    }

    let body = normalize_markdown_body_for_serialization(&page.body);
    Ok(format!("---\n{yaml}---\n{body}"))
}

pub fn parse_wiki_page(markdown: &str) -> Result<WikiPage, KnowledgeModelError> {
    let (frontmatter, body) = split_frontmatter(markdown)?;
    let parsed: WikiFrontmatter = serde_yaml::from_str(frontmatter)
        .map_err(|error| KnowledgeModelError::new("frontmatter", error.to_string()))?;
    let page = parsed.into_wiki_page(body.to_string());
    validate_wiki_page(&page)?;
    Ok(page)
}

fn validate_memory_item(item: &MemoryItem) -> Result<(), KnowledgeModelError> {
    validate_prefixed_id(&item.id, KnowledgeIdPrefix::Memory, "id")?;
    if let Some(kind) = item.kind.as_deref() {
        validate_non_empty_limited(kind, "kind", 40)?;
    }
    validate_non_empty_limited(&item.title, "title", MAX_TITLE_CHARS)?;
    if !matches!(
        item.status,
        MemoryStatus::Active | MemoryStatus::Archived | MemoryStatus::Superseded
    ) {
        return Err(KnowledgeModelError::new("status", "Invalid memory status"));
    }
    for tag in &item.tags {
        validate_non_empty_limited(tag, "tags", 40)?;
    }
    validate_source_refs(&item.source_refs)?;
    validate_timestamp(&item.created_at, "created_at")?;
    validate_timestamp(&item.updated_at, "updated_at")?;
    validate_prefixed_id(
        &item.proposal_id,
        KnowledgeIdPrefix::Proposal,
        "proposal_id",
    )?;
    let decision_document =
        validate_safe_vault_relative_path(&item.decision_document, "decision_document")?;
    if !decision_document.starts_with("Knowledge/decisions/") {
        return Err(KnowledgeModelError::new(
            "decision_document",
            "Decision document must be under Knowledge/decisions/",
        ));
    }
    if item.body.trim().is_empty() {
        return Err(KnowledgeModelError::new("body", "Body is empty"));
    }
    Ok(())
}

fn validate_wiki_page(page: &WikiPage) -> Result<(), KnowledgeModelError> {
    validate_prefixed_id(&page.id, KnowledgeIdPrefix::Wiki, "id")?;
    validate_non_empty_limited(&page.title, "title", MAX_TITLE_CHARS)?;
    if !matches!(
        page.status,
        WikiPageStatus::Active | WikiPageStatus::Archived | WikiPageStatus::Superseded
    ) {
        return Err(KnowledgeModelError::new("status", "Invalid wiki status"));
    }
    for tag in &page.tags {
        validate_non_empty_limited(tag, "tags", 40)?;
    }
    validate_source_refs(&page.source_refs)?;
    validate_timestamp(&page.created_at, "created_at")?;
    validate_timestamp(&page.updated_at, "updated_at")?;
    validate_prefixed_id(
        &page.proposal_id,
        KnowledgeIdPrefix::Proposal,
        "proposal_id",
    )?;
    let decision_document =
        validate_safe_vault_relative_path(&page.decision_document, "decision_document")?;
    if !decision_document.starts_with("Knowledge/decisions/") {
        return Err(KnowledgeModelError::new(
            "decision_document",
            "Decision document must be under Knowledge/decisions/",
        ));
    }
    if page.body.trim().is_empty() {
        return Err(KnowledgeModelError::new("body", "Body is empty"));
    }
    Ok(())
}

fn validate_source_refs(source_refs: &[SourceRef]) -> Result<(), KnowledgeModelError> {
    for source_ref in source_refs {
        let path = validate_safe_vault_relative_path(&source_ref.path, "source_refs.path")?;
        if path.chars().count() > MAX_SOURCE_PATH_CHARS {
            return Err(KnowledgeModelError::new(
                "source_refs.path",
                "Path is too long",
            ));
        }
        if let Some(title) = source_ref.title.as_deref() {
            validate_non_empty_limited(title, "source_refs.title", MAX_TITLE_CHARS)?;
        }
        if let Some(section_path) = source_ref.section_path.as_ref() {
            if section_path.len() > MAX_SECTION_PATH_ENTRIES {
                return Err(KnowledgeModelError::new(
                    "source_refs.section_path",
                    "Too many section path entries",
                ));
            }
            for entry in section_path {
                validate_non_empty_limited(
                    entry,
                    "source_refs.section_path",
                    MAX_SECTION_PATH_ENTRY_CHARS,
                )?;
            }
        }
        validate_range(source_ref.range.as_ref())?;
        if let Some(checksum) = source_ref.checksum.as_deref() {
            validate_sha256_checksum(checksum, "source_refs.checksum")?;
        }
        validate_timestamp(&source_ref.captured_at, "source_refs.captured_at")?;
    }
    Ok(())
}

fn split_frontmatter(markdown: &str) -> Result<(&str, &str), KnowledgeModelError> {
    let rest = markdown
        .strip_prefix("---\n")
        .ok_or_else(|| KnowledgeModelError::new("frontmatter", "Missing frontmatter"))?;
    let Some(index) = rest.find("\n---\n") else {
        return Err(KnowledgeModelError::new(
            "frontmatter",
            "Missing closing frontmatter marker",
        ));
    };
    Ok((&rest[..index], &rest[index + "\n---\n".len()..]))
}

fn validate_prefixed_id(
    value: &str,
    prefix: KnowledgeIdPrefix,
    field: &str,
) -> Result<(), KnowledgeModelError> {
    let expected = format!("{}_", prefix.as_str());
    if !value.starts_with(&expected) || !valid_id_body(&value[expected.len()..]) {
        return Err(KnowledgeModelError::new(field, "Invalid Knowledge id"));
    }
    Ok(())
}

fn valid_id_body(body: &str) -> bool {
    let mut chars = body.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    if body.chars().count() > MAX_ID_BODY_LEN {
        return false;
    }
    chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
}

fn sanitize_id_body(seed: &str) -> String {
    let seed = strip_known_prefix(seed);
    let mut body = String::new();
    let mut last_was_underscore = false;

    for ch in seed.chars() {
        if ch.is_ascii_alphanumeric() {
            body.push(ch.to_ascii_lowercase());
            last_was_underscore = false;
        } else if !last_was_underscore && !body.is_empty() {
            body.push('_');
            last_was_underscore = true;
        }
    }

    while body.ends_with('_') {
        body.pop();
    }
    if body.is_empty() {
        body.push_str("memory");
    }
    truncate_chars(&body, MAX_ID_BODY_LEN)
}

fn strip_known_prefix(value: &str) -> &str {
    for prefix in ["mem_", "wiki_", "prop_", "change_", "decision_", "doc_"] {
        if let Some(stripped) = value.strip_prefix(prefix) {
            return stripped;
        }
    }
    value
}

fn truncate_for_suffix(value: &str, suffix: &str, max_len: usize) -> String {
    let suffix_len = suffix.chars().count();
    let base_len = max_len.saturating_sub(suffix_len);
    truncate_chars(value, base_len)
}

fn truncate_chars(value: &str, max_len: usize) -> String {
    value.chars().take(max_len).collect()
}

fn has_windows_drive_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\'
}

fn percent_decode_segment(value: &str, field: &str) -> Result<String, KnowledgeModelError> {
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
            return Err(KnowledgeModelError::new(
                field,
                "Malformed percent encoding",
            ));
        }
        let Some(high) = hex_value(bytes[index + 1]) else {
            return Err(KnowledgeModelError::new(
                field,
                "Malformed percent encoding",
            ));
        };
        let Some(low) = hex_value(bytes[index + 2]) else {
            return Err(KnowledgeModelError::new(
                field,
                "Malformed percent encoding",
            ));
        };
        let decoded = high << 4 | low;
        if decoded == b'/' || decoded == b'\\' {
            return Err(KnowledgeModelError::new(
                field,
                "Percent-encoded separators are not allowed",
            ));
        }
        output.push(decoded);
        index += 3;
    }

    let decoded =
        String::from_utf8(output).map_err(|_| KnowledgeModelError::new(field, "Invalid UTF-8"))?;
    if contains_percent_encoding(&decoded) {
        return Err(KnowledgeModelError::new(
            field,
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

fn is_reserved_filename(value: &str) -> bool {
    matches!(
        value.to_ascii_uppercase().as_str(),
        "." | ".." | ".DS_STORE" | "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "LPT1"
    )
}

fn optional_trimmed_limited(
    value: Option<String>,
    field: &str,
    max_chars: usize,
) -> Result<Option<String>, KnowledgeModelError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    validate_non_empty_limited(trimmed, field, max_chars)?;
    Ok(Some(trimmed.to_string()))
}

fn normalize_section_path(
    value: Option<Vec<String>>,
) -> Result<Option<Vec<String>>, KnowledgeModelError> {
    let Some(entries) = value else {
        return Ok(None);
    };
    if entries.len() > MAX_SECTION_PATH_ENTRIES {
        return Err(KnowledgeModelError::new(
            "source_refs.section_path",
            "Too many section path entries",
        ));
    }

    let mut normalized = Vec::new();
    for entry in entries {
        let trimmed = entry.trim();
        validate_non_empty_limited(
            trimmed,
            "source_refs.section_path",
            MAX_SECTION_PATH_ENTRY_CHARS,
        )?;
        normalized.push(trimmed.to_string());
    }
    Ok(Some(normalized))
}

fn validate_range(value: Option<&SourceRange>) -> Result<(), KnowledgeModelError> {
    let Some(range) = value else {
        return Ok(());
    };
    if range.start_line == 0 || range.end_line == 0 || range.start_line > range.end_line {
        return Err(KnowledgeModelError::new(
            "source_refs.range",
            "Invalid source range",
        ));
    }
    Ok(())
}

fn validate_non_empty_limited(
    value: &str,
    field: &str,
    max_chars: usize,
) -> Result<(), KnowledgeModelError> {
    if value.trim().is_empty() {
        return Err(KnowledgeModelError::new(field, "Value is empty"));
    }
    if value.chars().count() > max_chars {
        return Err(KnowledgeModelError::new(field, "Value is too long"));
    }
    Ok(())
}

pub fn validate_sha256_checksum(value: &str, field: &str) -> Result<(), KnowledgeModelError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(KnowledgeModelError::new(field, "Invalid checksum prefix"));
    };
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(KnowledgeModelError::new(field, "Invalid checksum"));
    }
    if hex.bytes().any(|byte| byte.is_ascii_uppercase()) {
        return Err(KnowledgeModelError::new(
            field,
            "Checksum hex must be lowercase",
        ));
    }
    Ok(())
}

fn validate_timestamp(value: &str, field: &str) -> Result<(), KnowledgeModelError> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map_err(|_| KnowledgeModelError::new(field, "Invalid timestamp"))?;
    if !value.ends_with('Z') || value.contains('.') {
        return Err(KnowledgeModelError::new(
            field,
            "Timestamp must be UTC seconds precision",
        ));
    }
    Ok(())
}

fn normalize_markdown_body_for_serialization(value: &str) -> String {
    let mut body = value.replace("\r\n", "\n").replace('\r', "\n");
    while body.ends_with('\n') {
        body.pop();
    }
    body.push('\n');
    body
}

fn normalize_memory_body_for_serialization(value: &str) -> String {
    normalize_markdown_body_for_serialization(value)
}

#[derive(Debug, Serialize, Deserialize)]
struct MemoryFrontmatter {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
    title: String,
    status: MemoryStatus,
    tags: Vec<String>,
    source_refs: Vec<SourceRef>,
    created_at: String,
    updated_at: String,
    proposal_id: String,
    decision_document: String,
}

impl From<&MemoryItem> for MemoryFrontmatter {
    fn from(value: &MemoryItem) -> Self {
        Self {
            id: value.id.clone(),
            kind: value.kind.clone(),
            title: value.title.clone(),
            status: value.status.clone(),
            tags: value.tags.clone(),
            source_refs: value.source_refs.clone(),
            created_at: value.created_at.clone(),
            updated_at: value.updated_at.clone(),
            proposal_id: value.proposal_id.clone(),
            decision_document: value.decision_document.clone(),
        }
    }
}

impl MemoryFrontmatter {
    fn into_memory_item(self, body: String) -> MemoryItem {
        MemoryItem {
            id: self.id,
            kind: self.kind,
            title: self.title,
            status: self.status,
            tags: self.tags,
            source_refs: self.source_refs,
            created_at: self.created_at,
            updated_at: self.updated_at,
            proposal_id: self.proposal_id,
            decision_document: self.decision_document,
            body,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct WikiFrontmatter {
    id: String,
    page_type: WikiPageType,
    title: String,
    status: WikiPageStatus,
    tags: Vec<String>,
    source_refs: Vec<SourceRef>,
    created_at: String,
    updated_at: String,
    proposal_id: String,
    decision_document: String,
}

impl From<&WikiPage> for WikiFrontmatter {
    fn from(value: &WikiPage) -> Self {
        Self {
            id: value.id.clone(),
            page_type: value.page_type.clone(),
            title: value.title.clone(),
            status: value.status.clone(),
            tags: value.tags.clone(),
            source_refs: value.source_refs.clone(),
            created_at: value.created_at.clone(),
            updated_at: value.updated_at.clone(),
            proposal_id: value.proposal_id.clone(),
            decision_document: value.decision_document.clone(),
        }
    }
}

impl WikiFrontmatter {
    fn into_wiki_page(self, body: String) -> WikiPage {
        WikiPage {
            id: self.id,
            page_type: self.page_type,
            title: self.title,
            status: self.status,
            tags: self.tags,
            source_refs: self.source_refs,
            created_at: self.created_at,
            updated_at: self.updated_at,
            proposal_id: self.proposal_id,
            decision_document: self.decision_document,
            body,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::time::{Duration, UNIX_EPOCH};

    use super::*;

    #[test]
    fn sha256_checksum_uses_raw_bytes_and_prefix() {
        assert_eq!(
            sha256_checksum_bytes(b"abc"),
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn timestamp_uses_utc_seconds_precision() {
        let time = UNIX_EPOCH + Duration::from_secs(1);

        assert_eq!(format_utc_timestamp(time), "1970-01-01T00:00:01Z");
        assert_eq!(format_path_timestamp(time), "1970-01-01T000001Z");
    }

    #[test]
    fn ids_are_sanitized_and_collision_retried() {
        assert_eq!(
            make_knowledge_id(KnowledgeIdPrefix::Memory, "mem_Session Cookie First!"),
            "mem_session_cookie_first"
        );

        let existing = BTreeSet::from(["mem_session_cookie_first".to_string()]);
        let id = make_collision_free_knowledge_id(
            KnowledgeIdPrefix::Memory,
            "Session Cookie First",
            |candidate| existing.contains(candidate),
        )
        .unwrap();

        assert_eq!(id, "mem_session_cookie_first_2");
        assert!(is_valid_knowledge_id(&id));
    }

    #[test]
    fn slug_generation_is_ascii_lowercase_and_bounded() {
        assert_eq!(
            slugify_title(" Session Cookie First! "),
            "session-cookie-first"
        );
        assert_eq!(slugify_title("한글"), "memory-proposal");
        assert_eq!(slugify_title(&"a".repeat(100)).len(), 80);
    }

    #[test]
    fn safe_paths_reject_traversal_and_encoded_separators() {
        assert!(validate_safe_vault_relative_path("../notes.md", "path").is_err());
        assert!(validate_safe_vault_relative_path("notes/%2fsecret.md", "path").is_err());
        assert!(validate_safe_vault_relative_path("notes/%252e%252e/a.md", "path").is_err());

        assert_eq!(
            validate_safe_vault_relative_path("Projects\\Auth%20Notes.md", "path").unwrap(),
            "Projects/Auth Notes.md"
        );
    }

    #[test]
    fn source_refs_normalize_and_ignore_input_captured_at() {
        let input = SourceRefInput {
            path: "Projects/Auth.md".to_string(),
            title: Some(" Auth notes ".to_string()),
            section_path: Some(vec![" Decisions ".to_string()]),
            range: Some(SourceRange {
                start_line: 1,
                end_line: 2,
            }),
            checksum: Some(
                "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
                    .to_string(),
            ),
            captured_at: Some("1900-01-01T00:00:00Z".to_string()),
        };

        let source_ref = normalize_source_ref(input, "2026-05-07T00:00:00Z").unwrap();

        assert_eq!(source_ref.path, "Projects/Auth.md");
        assert_eq!(source_ref.title.as_deref(), Some("Auth notes"));
        assert_eq!(source_ref.section_path, Some(vec!["Decisions".to_string()]));
        assert_eq!(source_ref.captured_at, "2026-05-07T00:00:00Z");
    }

    #[test]
    fn memory_item_serializes_and_round_trips() {
        let item = MemoryItem {
            id: "mem_session_cookie_first".to_string(),
            kind: Some("decision".to_string()),
            title: "Session cookie first".to_string(),
            status: MemoryStatus::Active,
            tags: vec!["auth".to_string()],
            source_refs: vec![],
            created_at: "2026-05-07T00:00:00Z".to_string(),
            updated_at: "2026-05-07T00:00:00Z".to_string(),
            proposal_id: "prop_session_cookie".to_string(),
            decision_document: "Knowledge/decisions/2026-05-07-session-cookie.md".to_string(),
            body: "Kuku should implement session cookie auth first.".to_string(),
        };

        let markdown = serialize_memory_item(&item).unwrap();
        assert_eq!(
            markdown,
            "---\n\
id: mem_session_cookie_first\n\
kind: decision\n\
title: Session cookie first\n\
status: active\n\
tags:\n\
- auth\n\
source_refs: []\n\
created_at: 2026-05-07T00:00:00Z\n\
updated_at: 2026-05-07T00:00:00Z\n\
proposal_id: prop_session_cookie\n\
decision_document: Knowledge/decisions/2026-05-07-session-cookie.md\n\
---\n\
Kuku should implement session cookie auth first.\n"
        );

        let parsed = parse_memory_item(&markdown).unwrap();
        assert_eq!(parsed.id, item.id);
        assert_eq!(parsed.kind, item.kind);
        assert_eq!(
            parsed.body,
            "Kuku should implement session cookie auth first.\n"
        );
        assert_eq!(serialize_memory_item(&parsed).unwrap(), markdown);
    }

    #[test]
    fn wiki_page_path_validation_accepts_only_committed_wiki_markdown() {
        assert_eq!(
            validate_wiki_page_path("Knowledge/wiki/concepts/Auth.md", "path").unwrap(),
            "Knowledge/wiki/concepts/Auth.md"
        );
        assert!(validate_wiki_page_path("Knowledge/wiki/concepts/Auth.txt", "path").is_err());
        assert!(validate_wiki_page_path("Knowledge/decisions/Auth.md", "path").is_err());
        assert!(validate_wiki_page_path("Knowledge/wiki/%2e%2e/Auth.md", "path").is_err());
    }

    #[test]
    fn wiki_page_serializes_and_round_trips() {
        let page = WikiPage {
            id: "wiki_auth_session_cookie".to_string(),
            page_type: WikiPageType::Concept,
            title: "Session cookie auth".to_string(),
            status: WikiPageStatus::Active,
            tags: vec!["auth".to_string()],
            source_refs: vec![SourceRef {
                path: "Projects/Auth.md".to_string(),
                title: Some("Auth".to_string()),
                section_path: Some(vec!["Decision".to_string()]),
                range: Some(SourceRange {
                    start_line: 3,
                    end_line: 8,
                }),
                checksum: None,
                captured_at: "2026-05-07T00:00:00Z".to_string(),
            }],
            created_at: "2026-05-07T00:00:00Z".to_string(),
            updated_at: "2026-05-07T00:00:00Z".to_string(),
            proposal_id: "prop_session_cookie".to_string(),
            decision_document: "Knowledge/decisions/2026-05-07-session-cookie.md".to_string(),
            body: "Use session cookie auth first.\n\nCross-link later.".to_string(),
        };

        let markdown = serialize_wiki_page(&page).unwrap();
        assert_eq!(
            markdown,
            concat!(
                "---\n",
                "id: wiki_auth_session_cookie\n",
                "page_type: concept\n",
                "title: Session cookie auth\n",
                "status: active\n",
                "tags:\n",
                "- auth\n",
                "source_refs:\n",
                "- path: Projects/Auth.md\n",
                "  title: Auth\n",
                "  section_path:\n",
                "  - Decision\n",
                "  range:\n",
                "    start_line: 3\n",
                "    end_line: 8\n",
                "  captured_at: 2026-05-07T00:00:00Z\n",
                "created_at: 2026-05-07T00:00:00Z\n",
                "updated_at: 2026-05-07T00:00:00Z\n",
                "proposal_id: prop_session_cookie\n",
                "decision_document: Knowledge/decisions/2026-05-07-session-cookie.md\n",
                "---\n",
                "Use session cookie auth first.\n",
                "\n",
                "Cross-link later.\n",
            )
        );

        let parsed = parse_wiki_page(&markdown).unwrap();
        assert_eq!(parsed.id, page.id);
        assert_eq!(parsed.page_type, WikiPageType::Concept);
        assert_eq!(parsed.source_refs[0].path, "Projects/Auth.md");
        assert_eq!(
            parsed.body,
            "Use session cookie auth first.\n\nCross-link later.\n"
        );
        assert_eq!(serialize_wiki_page(&parsed).unwrap(), markdown);
    }

    #[test]
    fn wiki_page_rejects_invalid_model_data() {
        let mut page = WikiPage {
            id: "wiki_auth".to_string(),
            page_type: WikiPageType::Concept,
            title: "Auth".to_string(),
            status: WikiPageStatus::Active,
            tags: vec![],
            source_refs: vec![],
            created_at: "2026-05-07T00:00:00Z".to_string(),
            updated_at: "2026-05-07T00:00:00Z".to_string(),
            proposal_id: "prop_auth".to_string(),
            decision_document: "Knowledge/decisions/2026-05-07-auth.md".to_string(),
            body: "Auth body.".to_string(),
        };

        page.id = "mem_auth".to_string();
        assert!(serialize_wiki_page(&page).is_err());

        page.id = "wiki_auth".to_string();
        page.decision_document = "Notes/auth.md".to_string();
        assert!(serialize_wiki_page(&page).is_err());
    }

    #[test]
    fn memory_item_omits_absent_optionals_and_orders_source_refs() {
        let item = MemoryItem {
            id: "mem_auth_notes".to_string(),
            kind: None,
            title: "Auth notes".to_string(),
            status: MemoryStatus::Active,
            tags: vec![],
            source_refs: vec![SourceRef {
                path: "Projects/Auth.md".to_string(),
                title: Some("Auth".to_string()),
                section_path: Some(vec!["Decisions".to_string()]),
                range: Some(SourceRange {
                    start_line: 2,
                    end_line: 4,
                }),
                checksum: Some(
                    "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
                        .to_string(),
                ),
                captured_at: "2026-05-07T00:00:00Z".to_string(),
            }],
            created_at: "2026-05-07T00:00:00Z".to_string(),
            updated_at: "2026-05-07T00:00:00Z".to_string(),
            proposal_id: "prop_auth_notes".to_string(),
            decision_document: "Knowledge/decisions/2026-05-07-auth-notes.md".to_string(),
            body: "Auth notes body.\n".to_string(),
        };

        let markdown = serialize_memory_item(&item).unwrap();

        assert!(!markdown.contains("\nkind:"));
        assert!(markdown.contains("tags: []\n"));
        let path = markdown.find("path: Projects/Auth.md").unwrap();
        let title = path + markdown[path..].find("title: Auth").unwrap();
        let section_path = path + markdown[path..].find("section_path:").unwrap();
        let range = path + markdown[path..].find("range:").unwrap();
        let checksum = path + markdown[path..].find("checksum: sha256:").unwrap();
        let captured_at = path
            + markdown[path..]
                .find("captured_at: 2026-05-07T00:00:00Z")
                .unwrap();

        assert!(path < title);
        assert!(title < section_path);
        assert!(section_path < range);
        assert!(range < checksum);
        assert!(checksum < captured_at);
    }
}
