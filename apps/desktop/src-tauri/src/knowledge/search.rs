use std::cmp::Ordering as CmpOrdering;
use std::path::{Path, PathBuf};

use icu_normalizer::ComposingNormalizerBorrowed;

use crate::knowledge::markdown::{parse_memory_item, validate_safe_vault_relative_path};
use crate::knowledge::models::{
    KnowledgeErrorCode, MemoryContextRequest, MemoryContextResult, MemoryItem, MemorySearchHit,
    MemorySearchResult, SearchMemoryRequest,
};

const DEFAULT_LIMIT: usize = 10;
const MAX_LIMIT: usize = 50;
const MAX_QUERY_CHARS: usize = 500;
const SNIPPET_MAX_CHARS: usize = 240;
const SNIPPET_LEADING_CHARS: usize = 120;

const TITLE_SCORE: u32 = 100;
const TAG_SCORE: u32 = 75;
const KIND_SCORE: u32 = 50;
const BODY_SCORE: u32 = 25;

#[derive(Debug, Clone)]
pub struct SearchServiceError {
    pub code: KnowledgeErrorCode,
    pub message: String,
}

impl SearchServiceError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: KnowledgeErrorCode::InvalidArgument,
            message: message.into(),
        }
    }

    fn io(message: impl Into<String>) -> Self {
        Self {
            code: KnowledgeErrorCode::IoError,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone)]
struct SearchCriteria {
    normalized_query: String,
    limit: usize,
    tags: Option<Vec<String>>,
    kinds: Option<Vec<String>>,
}

struct ScoredMemory {
    item: MemoryItem,
    path: String,
    score: u32,
    snippet: String,
}

pub async fn search_memory_for_root(
    root: &Path,
    request: SearchMemoryRequest,
) -> Result<MemorySearchResult, SearchServiceError> {
    let criteria = normalize_search_request(request)?;
    let candidate_paths = collect_memory_markdown_paths(root).await?;
    let mut hits = Vec::new();
    let mut warnings = Vec::new();
    let mut skipped_paths = Vec::new();

    for candidate in candidate_paths {
        let markdown = match tokio::fs::read_to_string(&candidate.absolute).await {
            Ok(markdown) => markdown,
            Err(error) => {
                push_skip(
                    &mut warnings,
                    &mut skipped_paths,
                    &candidate.relative,
                    format!("failed to read file: {error}"),
                );
                continue;
            }
        };

        let item = match parse_memory_item(&markdown) {
            Ok(item) => item,
            Err(error) => {
                push_skip(
                    &mut warnings,
                    &mut skipped_paths,
                    &candidate.relative,
                    format!("{}: {}", error.field, error.message),
                );
                continue;
            }
        };

        let canonical_path = memory_path_for_id(&item.id);
        if candidate.relative != canonical_path {
            push_skip(
                &mut warnings,
                &mut skipped_paths,
                &candidate.relative,
                format!("filename does not match MemoryItem id {}", item.id),
            );
            continue;
        }

        if !matches_filters(&item, &criteria) {
            continue;
        }

        let score = score_memory(&item, &criteria.normalized_query);
        if score == 0 {
            continue;
        }

        let snippet = make_snippet(&item.body, &criteria.normalized_query);
        hits.push(ScoredMemory {
            item,
            path: canonical_path,
            score,
            snippet,
        });
    }

    hits.sort_by(compare_scored_memory);
    hits.truncate(criteria.limit);

    Ok(MemorySearchResult {
        hits: hits.into_iter().map(MemorySearchHit::from).collect(),
        warnings,
        skipped_paths,
    })
}

pub async fn memory_context_for_root(
    root: &Path,
    request: MemoryContextRequest,
) -> Result<MemoryContextResult, SearchServiceError> {
    if let Some(active_path) = request.active_path.as_deref()
        && !active_path.trim().is_empty()
    {
        validate_safe_vault_relative_path(active_path, "active_path").map_err(|error| {
            SearchServiceError::invalid(format!("{}: {}", error.field, error.message))
        })?;
    }

    let query = validate_query(&request.query)?;
    let result = search_memory_for_root(
        root,
        SearchMemoryRequest {
            query: query.clone(),
            limit: request.limit,
            tags: Vec::new(),
            kinds: Vec::new(),
        },
    )
    .await?;

    Ok(MemoryContextResult {
        query,
        memories: result.hits,
        warnings: result.warnings,
        skipped_paths: result.skipped_paths,
    })
}

pub fn normalize_search_text(value: &str) -> String {
    let normalizer = ComposingNormalizerBorrowed::new_nfc();
    let normalized = normalizer.normalize(value).to_string();
    normalized.chars().flat_map(char::to_lowercase).collect()
}

fn normalize_search_request(
    request: SearchMemoryRequest,
) -> Result<SearchCriteria, SearchServiceError> {
    let query = validate_query(&request.query)?;
    let normalized_query = normalize_search_text(&query);
    let limit = request.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
    let tags = normalize_filter_values(request.tags);
    let kinds = normalize_filter_values(request.kinds);

    Ok(SearchCriteria {
        normalized_query,
        limit,
        tags,
        kinds,
    })
}

fn validate_query(value: &str) -> Result<String, SearchServiceError> {
    let query = value.trim().to_string();
    if query.is_empty() {
        return Err(SearchServiceError::invalid("query must not be empty"));
    }
    if query.chars().count() > MAX_QUERY_CHARS {
        return Err(SearchServiceError::invalid(format!(
            "query must be at most {MAX_QUERY_CHARS} characters",
        )));
    }
    Ok(query)
}

fn normalize_filter_values(values: Vec<String>) -> Option<Vec<String>> {
    let normalized = values
        .into_iter()
        .filter_map(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(normalize_search_text(trimmed))
            }
        })
        .collect::<Vec<_>>();

    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

#[derive(Debug, Clone)]
struct MemoryCandidatePath {
    absolute: PathBuf,
    relative: String,
}

async fn collect_memory_markdown_paths(
    root: &Path,
) -> Result<Vec<MemoryCandidatePath>, SearchServiceError> {
    let memory_dir = root.join("Knowledge/memory");
    let mut read_dir = match tokio::fs::read_dir(&memory_dir).await {
        Ok(read_dir) => read_dir,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(SearchServiceError::io(error.to_string())),
    };

    let mut paths = Vec::new();
    loop {
        let Some(entry) = read_dir
            .next_entry()
            .await
            .map_err(|error| SearchServiceError::io(error.to_string()))?
        else {
            break;
        };

        let file_type = entry
            .file_type()
            .await
            .map_err(|error| SearchServiceError::io(error.to_string()))?;
        if !file_type.is_file() {
            continue;
        }

        let file_name = entry.file_name().to_string_lossy().into_owned();
        if !file_name.ends_with(".md") {
            continue;
        }

        paths.push(MemoryCandidatePath {
            absolute: entry.path(),
            relative: format!("Knowledge/memory/{file_name}"),
        });
    }

    paths.sort_by(|left, right| left.relative.cmp(&right.relative));
    Ok(paths)
}

fn push_skip(
    warnings: &mut Vec<String>,
    skipped_paths: &mut Vec<String>,
    path: &str,
    reason: impl Into<String>,
) {
    let reason = reason.into();
    skipped_paths.push(path.to_string());
    warnings.push(format!("Skipped malformed MemoryItem {path}: {reason}"));
}

fn memory_path_for_id(id: &str) -> String {
    format!("Knowledge/memory/{id}.md")
}

fn matches_filters(item: &MemoryItem, criteria: &SearchCriteria) -> bool {
    if let Some(tags) = criteria.tags.as_ref() {
        let item_tags = item
            .tags
            .iter()
            .map(|tag| normalize_search_text(tag))
            .collect::<Vec<_>>();
        if !tags
            .iter()
            .any(|filter_tag| item_tags.iter().any(|tag| tag == filter_tag))
        {
            return false;
        }
    }

    if let Some(kinds) = criteria.kinds.as_ref() {
        let Some(kind) = item.kind.as_deref() else {
            return false;
        };
        let normalized_kind = normalize_search_text(kind);
        if !kinds
            .iter()
            .any(|filter_kind| filter_kind == &normalized_kind)
        {
            return false;
        }
    }

    true
}

fn score_memory(item: &MemoryItem, normalized_query: &str) -> u32 {
    let mut score = 0;
    if normalize_search_text(&item.title).contains(normalized_query) {
        score = score.max(TITLE_SCORE);
    }
    if item
        .tags
        .iter()
        .any(|tag| normalize_search_text(tag).contains(normalized_query))
    {
        score = score.max(TAG_SCORE);
    }
    if item
        .kind
        .as_deref()
        .is_some_and(|kind| normalize_search_text(kind).contains(normalized_query))
    {
        score = score.max(KIND_SCORE);
    }
    if normalize_search_text(&item.body).contains(normalized_query) {
        score = score.max(BODY_SCORE);
    }
    score
}

fn compare_scored_memory(left: &ScoredMemory, right: &ScoredMemory) -> CmpOrdering {
    right
        .score
        .cmp(&left.score)
        .then_with(|| right.item.updated_at.cmp(&left.item.updated_at))
        .then_with(|| left.path.cmp(&right.path))
}

fn make_snippet(body: &str, normalized_query: &str) -> String {
    let chars = body.chars().collect::<Vec<_>>();
    if chars.is_empty() {
        return String::new();
    }

    let match_start = first_match_start_char(body, normalized_query).unwrap_or(0);
    let content_start = match_start.saturating_sub(SNIPPET_LEADING_CHARS);
    let leading_omitted = content_start > 0;
    let prefix_len = if leading_omitted { 3 } else { 0 };

    let first_content_max = SNIPPET_MAX_CHARS.saturating_sub(prefix_len);
    let first_content_end = chars.len().min(content_start + first_content_max);
    let trailing_omitted = first_content_end < chars.len();
    let suffix_len = if trailing_omitted { 3 } else { 0 };
    let content_max = SNIPPET_MAX_CHARS
        .saturating_sub(prefix_len)
        .saturating_sub(suffix_len);
    let content_end = chars.len().min(content_start + content_max);

    let mut snippet = String::new();
    if leading_omitted {
        snippet.push_str("...");
    }
    snippet.extend(chars[content_start..content_end].iter());
    if content_end < chars.len() {
        snippet.push_str("...");
    }
    snippet
}

fn first_match_start_char(body: &str, normalized_query: &str) -> Option<usize> {
    let normalized_body = normalize_search_text(body);
    let match_index = normalized_body.find(normalized_query)?;
    Some(normalized_body[..match_index].chars().count())
}

impl From<ScoredMemory> for MemorySearchHit {
    fn from(value: ScoredMemory) -> Self {
        Self {
            id: value.item.id,
            path: value.path,
            title: value.item.title,
            kind: value.item.kind,
            snippet: value.snippet,
            tags: value.item.tags,
            source_refs: value.item.source_refs,
            score: value.score,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use tauri::async_runtime;

    use super::*;
    use crate::knowledge::markdown::serialize_memory_item;
    use crate::knowledge::models::{MemoryStatus, SourceRef};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn direct_scan_matches_scores_filters_snippets_and_normalizes_unicode() {
        let root = temp_vault();
        write_memory(
            &root,
            memory_item(
                "mem_title",
                Some("decision"),
                "Cafe\u{301} session policy",
                "A body without the query.",
                vec!["auth"],
                "2026-05-07T00:00:01Z",
            ),
        );
        write_memory(
            &root,
            memory_item(
                "mem_tag",
                Some("fact"),
                "Auth token storage",
                "A body without the query.",
                vec!["Session"],
                "2026-05-07T00:00:04Z",
            ),
        );
        write_memory(
            &root,
            memory_item(
                "mem_kind",
                Some("session"),
                "Auth token storage",
                "A body without the query.",
                vec!["auth"],
                "2026-05-07T00:00:03Z",
            ),
        );
        write_memory(
            &root,
            memory_item(
                "mem_body",
                Some("decision"),
                "Auth token storage",
                &format!("{}session{}", "a".repeat(130), "b".repeat(200)),
                vec!["auth"],
                "2026-05-07T00:00:05Z",
            ),
        );

        let result = async_runtime::block_on(search_memory_for_root(
            &root,
            SearchMemoryRequest {
                query: "café".to_string(),
                limit: None,
                tags: Vec::new(),
                kinds: Vec::new(),
            },
        ))
        .unwrap();
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].id, "mem_title");

        let result = async_runtime::block_on(search_memory_for_root(
            &root,
            SearchMemoryRequest {
                query: "session".to_string(),
                limit: None,
                tags: Vec::new(),
                kinds: Vec::new(),
            },
        ))
        .unwrap();

        assert_eq!(
            result
                .hits
                .iter()
                .map(|hit| hit.id.as_str())
                .collect::<Vec<_>>(),
            vec!["mem_title", "mem_tag", "mem_kind", "mem_body"]
        );
        assert_eq!(
            result.hits.iter().map(|hit| hit.score).collect::<Vec<_>>(),
            vec![100, 75, 50, 25]
        );
        assert!(result.hits[3].snippet.starts_with("..."));
        assert!(result.hits[3].snippet.ends_with("..."));
        assert!(result.hits[3].snippet.chars().count() <= SNIPPET_MAX_CHARS);

        let filtered = async_runtime::block_on(search_memory_for_root(
            &root,
            SearchMemoryRequest {
                query: "session".to_string(),
                limit: None,
                tags: vec![" AUTH ".to_string()],
                kinds: vec!["DECISION".to_string()],
            },
        ))
        .unwrap();
        assert_eq!(
            filtered
                .hits
                .iter()
                .map(|hit| hit.id.as_str())
                .collect::<Vec<_>>(),
            vec!["mem_title", "mem_body"]
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn direct_scan_excludes_decisions_and_proposals() {
        let root = temp_vault();
        fs::create_dir_all(root.join("Knowledge/decisions")).unwrap();
        fs::create_dir_all(root.join("Knowledge/proposals")).unwrap();
        let markdown = serialize_memory_item(&memory_item(
            "mem_hidden",
            Some("fact"),
            "Session hidden",
            "Session body.",
            vec![],
            "2026-05-07T00:00:01Z",
        ))
        .unwrap();
        fs::write(root.join("Knowledge/decisions/mem_hidden.md"), &markdown).unwrap();
        fs::write(root.join("Knowledge/proposals/mem_hidden.md"), markdown).unwrap();

        let result = async_runtime::block_on(search_memory_for_root(
            &root,
            SearchMemoryRequest {
                query: "session".to_string(),
                limit: None,
                tags: Vec::new(),
                kinds: Vec::new(),
            },
        ))
        .unwrap();

        assert!(result.hits.is_empty());
        assert!(result.skipped_paths.is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn malformed_memory_items_are_skipped_with_warnings() {
        let root = temp_vault();
        fs::create_dir_all(root.join("Knowledge/memory")).unwrap();
        fs::write(root.join("Knowledge/memory/bad.md"), "not memory markdown").unwrap();
        let wrong_name = serialize_memory_item(&memory_item(
            "mem_wrong_name",
            Some("fact"),
            "Session wrong name",
            "Session body.",
            vec![],
            "2026-05-07T00:00:01Z",
        ))
        .unwrap();
        fs::write(root.join("Knowledge/memory/not_mem_id.md"), wrong_name).unwrap();
        fs::write(
            root.join("Knowledge/memory/mem_bad_source.md"),
            "---\nid: mem_bad_source\ntitle: Session bad source\nstatus: active\ntags: []\nsource_refs:\n  - path: Notes/Auth.md\n    captured_at: not-a-timestamp\ncreated_at: 2026-05-07T00:00:00Z\nupdated_at: 2026-05-07T00:00:00Z\nproposal_id: prop_source\ndecision_document: Knowledge/decisions/source.md\n---\nSession body.\n",
        )
        .unwrap();
        write_memory(
            &root,
            memory_item(
                "mem_valid",
                Some("fact"),
                "Session valid",
                "Session body.",
                vec![],
                "2026-05-07T00:00:02Z",
            ),
        );

        let result = async_runtime::block_on(search_memory_for_root(
            &root,
            SearchMemoryRequest {
                query: "session".to_string(),
                limit: None,
                tags: Vec::new(),
                kinds: Vec::new(),
            },
        ))
        .unwrap();

        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].id, "mem_valid");
        assert_eq!(
            result.skipped_paths,
            vec![
                "Knowledge/memory/bad.md",
                "Knowledge/memory/mem_bad_source.md",
                "Knowledge/memory/not_mem_id.md"
            ]
        );
        assert_eq!(result.warnings.len(), 3);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn limit_is_capped_and_equal_scores_are_ordered_deterministically() {
        let root = temp_vault();
        for index in (0..55).rev() {
            write_memory(
                &root,
                memory_item(
                    &format!("mem_cap_{index:03}"),
                    Some("fact"),
                    &format!("Cap memory {index:03}"),
                    "Cap body.",
                    vec![],
                    "2026-05-07T00:00:00Z",
                ),
            );
        }

        let result = async_runtime::block_on(search_memory_for_root(
            &root,
            SearchMemoryRequest {
                query: "cap".to_string(),
                limit: Some(999),
                tags: Vec::new(),
                kinds: Vec::new(),
            },
        ))
        .unwrap();

        assert_eq!(result.hits.len(), MAX_LIMIT);
        assert_eq!(result.hits[0].path, "Knowledge/memory/mem_cap_000.md");
        assert_eq!(result.hits[49].path, "Knowledge/memory/mem_cap_049.md");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn query_validation_rejects_empty_and_overlong_queries() {
        let root = temp_vault();

        let empty = async_runtime::block_on(search_memory_for_root(
            &root,
            SearchMemoryRequest {
                query: "   ".to_string(),
                limit: None,
                tags: Vec::new(),
                kinds: Vec::new(),
            },
        ))
        .unwrap_err();
        assert_eq!(empty.code, KnowledgeErrorCode::InvalidArgument);

        let overlong = async_runtime::block_on(search_memory_for_root(
            &root,
            SearchMemoryRequest {
                query: "x".repeat(MAX_QUERY_CHARS + 1),
                limit: None,
                tags: Vec::new(),
                kinds: Vec::new(),
            },
        ))
        .unwrap_err();
        assert_eq!(overlong.code, KnowledgeErrorCode::InvalidArgument);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn memory_context_reuses_search_results_and_validates_active_path() {
        let root = temp_vault();
        write_memory(
            &root,
            memory_item(
                "mem_context",
                Some("fact"),
                "Session context",
                "Session body.",
                vec![],
                "2026-05-07T00:00:00Z",
            ),
        );

        let result = async_runtime::block_on(memory_context_for_root(
            &root,
            MemoryContextRequest {
                query: " session ".to_string(),
                active_path: Some("Notes/Auth.md".to_string()),
                limit: Some(5),
            },
        ))
        .unwrap();

        assert_eq!(result.query, "session");
        assert_eq!(result.memories.len(), 1);
        assert_eq!(result.memories[0].id, "mem_context");

        let invalid = async_runtime::block_on(memory_context_for_root(
            &root,
            MemoryContextRequest {
                query: "session".to_string(),
                active_path: Some("../outside.md".to_string()),
                limit: None,
            },
        ))
        .unwrap_err();
        assert_eq!(invalid.code, KnowledgeErrorCode::InvalidArgument);

        let _ = fs::remove_dir_all(root);
    }

    fn write_memory(root: &Path, item: MemoryItem) {
        fs::create_dir_all(root.join("Knowledge/memory")).unwrap();
        let path = root.join(memory_path_for_id(&item.id));
        fs::write(path, serialize_memory_item(&item).unwrap()).unwrap();
    }

    fn memory_item(
        id: &str,
        kind: Option<&str>,
        title: &str,
        body: &str,
        tags: Vec<&str>,
        updated_at: &str,
    ) -> MemoryItem {
        MemoryItem {
            id: id.to_string(),
            kind: kind.map(ToString::to_string),
            title: title.to_string(),
            status: MemoryStatus::Active,
            tags: tags.into_iter().map(ToString::to_string).collect(),
            source_refs: vec![SourceRef {
                path: "Notes/Auth.md".to_string(),
                title: Some("Auth notes".to_string()),
                section_path: Some(vec!["Decisions".to_string()]),
                range: None,
                checksum: None,
                captured_at: "2026-05-07T00:00:00Z".to_string(),
            }],
            created_at: "2026-05-07T00:00:00Z".to_string(),
            updated_at: updated_at.to_string(),
            proposal_id: "prop_search".to_string(),
            decision_document: "Knowledge/decisions/search.md".to_string(),
            body: body.to_string(),
        }
    }

    fn temp_vault() -> PathBuf {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let seq = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("kuku-knowledge-search-test-{now}-{seq}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
