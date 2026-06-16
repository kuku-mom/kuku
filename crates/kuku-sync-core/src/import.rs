use serde::{Deserialize, Serialize};

use crate::path::normalize_path;
use crate::projection::ProjectedSnapshot;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExpectedMutation {
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
    pub normalized_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportCandidateInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_normalized_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_normalized_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_snapshot: Option<ProjectedSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_snapshot: Option<ProjectedSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_mutation: Option<ExpectedMutation>,
    #[serde(default)]
    pub has_path_collision: bool,
    #[serde(default)]
    pub encoding_issue: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ImportCandidate {
    ExternalCreate {
        normalized_path: String,
        content_hash: String,
        confidence: ImportConfidence,
    },
    ExternalModify {
        file_id: String,
        normalized_path: String,
        content_hash: String,
        confidence: ImportConfidence,
    },
    ExternalDelete {
        file_id: String,
        normalized_path: String,
        confidence: ImportConfidence,
    },
    ExternalRename {
        file_id: String,
        from_normalized_path: String,
        to_normalized_path: String,
        content_hash: String,
        confidence: ImportConfidence,
    },
    Suppressed {
        mutation_token: String,
        normalized_path: String,
    },
    Unchanged {
        normalized_path: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ImportConfidence {
    AutoImport { reason: ImportAutoReason },
    ReviewRequired { reason: ImportReviewReason },
    DeleteGrace { reason: ImportReviewReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportAutoReason {
    ExternalCreate,
    ExternalRename,
    SmallLocalizedEdit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportReviewReason {
    ExternalDelete,
    LargeRewrite,
    FormatterRewrite,
    EncodingIssue,
    PathCollision,
    MissingComparisonBase,
}

pub fn classify_import_candidate(input: ImportCandidateInput) -> ImportCandidate {
    let previous_path = normalized_input_path(
        input.previous_normalized_path.as_deref(),
        input
            .previous_snapshot
            .as_ref()
            .map(|snapshot| snapshot.normalized_path.as_str()),
    );
    let current_path = normalized_input_path(
        input.current_normalized_path.as_deref(),
        input
            .current_snapshot
            .as_ref()
            .map(|snapshot| snapshot.normalized_path.as_str()),
    );
    if let Some(expected) =
        matching_expected_mutation(&input, previous_path.as_deref(), current_path.as_deref())
    {
        return ImportCandidate::Suppressed {
            mutation_token: expected.token.clone(),
            normalized_path: normalize_path(&expected.normalized_path),
        };
    }

    let file_id = input
        .file_id
        .clone()
        .or_else(|| {
            input
                .previous_snapshot
                .as_ref()
                .map(|snapshot| snapshot.file_id.clone())
        })
        .or_else(|| {
            input
                .current_snapshot
                .as_ref()
                .map(|snapshot| snapshot.file_id.clone())
        })
        .unwrap_or_default();
    let previous_hash = input
        .previous_snapshot
        .as_ref()
        .map(|snapshot| snapshot.content_hash.as_str());
    let current_hash = input
        .current_snapshot
        .as_ref()
        .map(|snapshot| snapshot.content_hash.as_str());

    match (previous_path, current_path, previous_hash, current_hash) {
        (None, Some(path), None, Some(hash)) => ImportCandidate::ExternalCreate {
            normalized_path: path,
            content_hash: hash.to_owned(),
            confidence: import_confidence_for_create(&input),
        },
        (Some(path), None, Some(_), None) => ImportCandidate::ExternalDelete {
            file_id,
            normalized_path: path,
            confidence: ImportConfidence::DeleteGrace {
                reason: ImportReviewReason::ExternalDelete,
            },
        },
        (Some(previous_path), Some(current_path), Some(_), Some(current_hash))
            if previous_path != current_path =>
        {
            ImportCandidate::ExternalRename {
                file_id,
                from_normalized_path: previous_path,
                to_normalized_path: current_path,
                content_hash: current_hash.to_owned(),
                confidence: import_confidence_for_rename_or_modify(
                    &input,
                    ImportAutoReason::ExternalRename,
                ),
            }
        }
        (Some(path), Some(_), Some(previous_hash), Some(current_hash))
            if previous_hash != current_hash =>
        {
            ImportCandidate::ExternalModify {
                file_id,
                normalized_path: path,
                content_hash: current_hash.to_owned(),
                confidence: import_confidence_for_rename_or_modify(
                    &input,
                    ImportAutoReason::SmallLocalizedEdit,
                ),
            }
        }
        (Some(path), Some(_), _, _) => ImportCandidate::Unchanged {
            normalized_path: path,
        },
        (None, Some(path), _, Some(hash)) => ImportCandidate::ExternalCreate {
            normalized_path: path,
            content_hash: hash.to_owned(),
            confidence: import_confidence_for_create(&input),
        },
        (Some(path), None, _, _) => ImportCandidate::ExternalDelete {
            file_id,
            normalized_path: path,
            confidence: ImportConfidence::DeleteGrace {
                reason: ImportReviewReason::ExternalDelete,
            },
        },
        (None, None, _, _) => ImportCandidate::Unchanged {
            normalized_path: String::new(),
        },
        (_, Some(path), _, None) => ImportCandidate::ExternalCreate {
            normalized_path: path,
            content_hash: String::new(),
            confidence: ImportConfidence::ReviewRequired {
                reason: ImportReviewReason::MissingComparisonBase,
            },
        },
    }
}

fn matching_expected_mutation<'a>(
    input: &'a ImportCandidateInput,
    previous_path: Option<&str>,
    current_path: Option<&str>,
) -> Option<&'a ExpectedMutation> {
    let expected = input.expected_mutation.as_ref()?;
    if let Some(expected_file_id) = &expected.file_id {
        let observed_file_id = input
            .file_id
            .as_ref()
            .or_else(|| {
                input
                    .previous_snapshot
                    .as_ref()
                    .map(|snapshot| &snapshot.file_id)
            })
            .or_else(|| {
                input
                    .current_snapshot
                    .as_ref()
                    .map(|snapshot| &snapshot.file_id)
            });
        if observed_file_id != Some(expected_file_id) {
            return None;
        }
    }

    let expected_path = normalize_path(&expected.normalized_path);
    let path_matches = current_path
        .or(previous_path)
        .map(|path| path == expected_path)
        .unwrap_or(false);
    if !path_matches {
        return None;
    }

    let hash_matches = expected.content_hash.as_ref().is_none_or(|expected_hash| {
        input
            .current_snapshot
            .as_ref()
            .map(|snapshot| snapshot.content_hash.as_str())
            == Some(expected_hash.as_str())
    });
    hash_matches.then_some(expected)
}

fn normalized_input_path(primary: Option<&str>, fallback: Option<&str>) -> Option<String> {
    primary.or(fallback).map(normalize_path)
}

fn import_confidence_for_create(input: &ImportCandidateInput) -> ImportConfidence {
    if input.has_path_collision {
        return ImportConfidence::ReviewRequired {
            reason: ImportReviewReason::PathCollision,
        };
    }
    if has_encoding_issue(input) {
        return ImportConfidence::ReviewRequired {
            reason: ImportReviewReason::EncodingIssue,
        };
    }
    ImportConfidence::AutoImport {
        reason: ImportAutoReason::ExternalCreate,
    }
}

fn import_confidence_for_rename_or_modify(
    input: &ImportCandidateInput,
    auto_reason: ImportAutoReason,
) -> ImportConfidence {
    if input.has_path_collision {
        return ImportConfidence::ReviewRequired {
            reason: ImportReviewReason::PathCollision,
        };
    }
    if has_encoding_issue(input) {
        return ImportConfidence::ReviewRequired {
            reason: ImportReviewReason::EncodingIssue,
        };
    }
    let Some(previous) = input.previous_content.as_deref() else {
        return ImportConfidence::ReviewRequired {
            reason: ImportReviewReason::MissingComparisonBase,
        };
    };
    let Some(current) = input.current_content.as_deref() else {
        return ImportConfidence::ReviewRequired {
            reason: ImportReviewReason::MissingComparisonBase,
        };
    };
    if formatter_like_rewrite(previous, current) {
        return ImportConfidence::ReviewRequired {
            reason: ImportReviewReason::FormatterRewrite,
        };
    }
    if large_rewrite(previous, current) {
        return ImportConfidence::ReviewRequired {
            reason: ImportReviewReason::LargeRewrite,
        };
    }
    ImportConfidence::AutoImport {
        reason: auto_reason,
    }
}

fn has_encoding_issue(input: &ImportCandidateInput) -> bool {
    input.encoding_issue
        || input
            .previous_content
            .as_deref()
            .is_some_and(|content| content.contains('\u{fffd}'))
        || input
            .current_content
            .as_deref()
            .is_some_and(|content| content.contains('\u{fffd}'))
}

fn formatter_like_rewrite(previous: &str, current: &str) -> bool {
    previous != current && whitespace_fold(previous) == whitespace_fold(current)
}

fn whitespace_fold(value: &str) -> String {
    value.split_whitespace().collect::<String>()
}

fn large_rewrite(previous: &str, current: &str) -> bool {
    if previous == current {
        return false;
    }
    let before = previous.as_bytes();
    let after = current.as_bytes();
    let max_len = before.len().max(after.len());
    if max_len == 0 {
        return false;
    }

    let prefix_len = common_prefix_len(before, after);
    let suffix_len = common_suffix_len(&before[prefix_len..], &after[prefix_len..]);
    let changed_before = before.len().saturating_sub(prefix_len + suffix_len);
    let changed_after = after.len().saturating_sub(prefix_len + suffix_len);
    let changed_ratio = changed_before.max(changed_after) as f64 / max_len as f64;

    changed_ratio > 0.50
}

fn common_prefix_len(before: &[u8], after: &[u8]) -> usize {
    before
        .iter()
        .zip(after)
        .take_while(|(left, right)| left == right)
        .count()
}

fn common_suffix_len(before: &[u8], after: &[u8]) -> usize {
    before
        .iter()
        .rev()
        .zip(after.iter().rev())
        .take_while(|(left, right)| left == right)
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::path::normalize_path;

    fn snapshot(file_id: &str, path: &str, hash: &str, generation: u64) -> ProjectedSnapshot {
        ProjectedSnapshot {
            file_id: file_id.to_owned(),
            normalized_path: normalize_path(path),
            content_hash: hash.to_owned(),
            mtime_ms: generation as i64 * 1000,
            size: hash.len() as u64,
            projection_generation: generation,
        }
    }

    #[test]
    fn small_localized_external_edit_is_auto_import_allowed() {
        let candidate = classify_import_candidate(ImportCandidateInput {
            file_id: Some("file-1".to_owned()),
            previous_normalized_path: Some("note.md".to_owned()),
            current_normalized_path: Some("note.md".to_owned()),
            previous_snapshot: Some(snapshot("file-1", "note.md", "hash-1", 1)),
            current_snapshot: Some(snapshot("file-1", "note.md", "hash-2", 2)),
            previous_content: Some("alpha\nbeta\ngamma\n".to_owned()),
            current_content: Some("alpha\nbeta edited\ngamma\n".to_owned()),
            expected_mutation: None,
            has_path_collision: false,
            encoding_issue: false,
        });

        match candidate {
            ImportCandidate::ExternalModify { confidence, .. } => {
                assert_eq!(
                    confidence,
                    ImportConfidence::AutoImport {
                        reason: ImportAutoReason::SmallLocalizedEdit
                    }
                );
            }
            other => panic!("expected external modify, got {other:?}"),
        }
    }

    #[test]
    fn large_whole_file_rewrite_requires_review() {
        let candidate = classify_import_candidate(ImportCandidateInput {
            file_id: Some("file-1".to_owned()),
            previous_normalized_path: Some("note.md".to_owned()),
            current_normalized_path: Some("note.md".to_owned()),
            previous_snapshot: Some(snapshot("file-1", "note.md", "hash-1", 1)),
            current_snapshot: Some(snapshot("file-1", "note.md", "hash-2", 2)),
            previous_content: Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned()),
            current_content: Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned()),
            expected_mutation: None,
            has_path_collision: false,
            encoding_issue: false,
        });

        match candidate {
            ImportCandidate::ExternalModify { confidence, .. } => {
                assert_eq!(
                    confidence,
                    ImportConfidence::ReviewRequired {
                        reason: ImportReviewReason::LargeRewrite
                    }
                );
            }
            other => panic!("expected external modify, got {other:?}"),
        }
    }

    #[test]
    fn formatter_like_rewrite_requires_review() {
        let candidate = classify_import_candidate(ImportCandidateInput {
            file_id: Some("file-1".to_owned()),
            previous_normalized_path: Some("note.md".to_owned()),
            current_normalized_path: Some("note.md".to_owned()),
            previous_snapshot: Some(snapshot("file-1", "note.md", "hash-1", 1)),
            current_snapshot: Some(snapshot("file-1", "note.md", "hash-2", 2)),
            previous_content: Some("alpha\nbeta\ngamma\n".to_owned()),
            current_content: Some("alpha\n\nbeta\n\ngamma\n".to_owned()),
            expected_mutation: None,
            has_path_collision: false,
            encoding_issue: false,
        });

        match candidate {
            ImportCandidate::ExternalModify { confidence, .. } => {
                assert_eq!(
                    confidence,
                    ImportConfidence::ReviewRequired {
                        reason: ImportReviewReason::FormatterRewrite
                    }
                );
            }
            other => panic!("expected external modify, got {other:?}"),
        }
    }

    #[test]
    fn path_collision_import_requires_review() {
        let candidate = classify_import_candidate(ImportCandidateInput {
            file_id: Some("file-1".to_owned()),
            previous_normalized_path: Some("note.md".to_owned()),
            current_normalized_path: Some("note.md".to_owned()),
            previous_snapshot: Some(snapshot("file-1", "note.md", "hash-1", 1)),
            current_snapshot: Some(snapshot("file-1", "note.md", "hash-2", 2)),
            previous_content: Some("alpha".to_owned()),
            current_content: Some("alpha edited".to_owned()),
            expected_mutation: None,
            has_path_collision: true,
            encoding_issue: false,
        });

        match candidate {
            ImportCandidate::ExternalModify { confidence, .. } => {
                assert_eq!(
                    confidence,
                    ImportConfidence::ReviewRequired {
                        reason: ImportReviewReason::PathCollision
                    }
                );
            }
            other => panic!("expected external modify, got {other:?}"),
        }
    }

    #[test]
    fn encoding_issue_import_requires_review() {
        let candidate = classify_import_candidate(ImportCandidateInput {
            file_id: Some("file-1".to_owned()),
            previous_normalized_path: Some("note.md".to_owned()),
            current_normalized_path: Some("note.md".to_owned()),
            previous_snapshot: Some(snapshot("file-1", "note.md", "hash-1", 1)),
            current_snapshot: Some(snapshot("file-1", "note.md", "hash-2", 2)),
            previous_content: Some("alpha".to_owned()),
            current_content: Some("alpha\u{fffd}".to_owned()),
            expected_mutation: None,
            has_path_collision: false,
            encoding_issue: false,
        });

        match candidate {
            ImportCandidate::ExternalModify { confidence, .. } => {
                assert_eq!(
                    confidence,
                    ImportConfidence::ReviewRequired {
                        reason: ImportReviewReason::EncodingIssue
                    }
                );
            }
            other => panic!("expected external modify, got {other:?}"),
        }
    }

    #[test]
    fn external_delete_is_grace_review_state() {
        let candidate = classify_import_candidate(ImportCandidateInput {
            file_id: Some("file-1".to_owned()),
            previous_normalized_path: Some("note.md".to_owned()),
            current_normalized_path: None,
            previous_snapshot: Some(snapshot("file-1", "note.md", "hash-1", 1)),
            current_snapshot: None,
            previous_content: Some("alpha".to_owned()),
            current_content: None,
            expected_mutation: None,
            has_path_collision: false,
            encoding_issue: false,
        });

        assert_eq!(
            candidate,
            ImportCandidate::ExternalDelete {
                file_id: "file-1".to_owned(),
                normalized_path: "note.md".to_owned(),
                confidence: ImportConfidence::DeleteGrace {
                    reason: ImportReviewReason::ExternalDelete
                },
            }
        );
    }

    #[test]
    fn expected_app_origin_mutation_token_suppresses_import_candidate() {
        let candidate = classify_import_candidate(ImportCandidateInput {
            file_id: Some("file-1".to_owned()),
            previous_normalized_path: Some("note.md".to_owned()),
            current_normalized_path: Some("note.md".to_owned()),
            previous_snapshot: Some(snapshot("file-1", "note.md", "hash-1", 1)),
            current_snapshot: Some(snapshot("file-1", "note.md", "projected-hash", 2)),
            previous_content: Some("alpha".to_owned()),
            current_content: Some("projected".to_owned()),
            expected_mutation: Some(ExpectedMutation {
                token: "projection-token-1".to_owned(),
                file_id: Some("file-1".to_owned()),
                normalized_path: "note.md".to_owned(),
                content_hash: Some("projected-hash".to_owned()),
            }),
            has_path_collision: false,
            encoding_issue: false,
        });

        assert_eq!(
            candidate,
            ImportCandidate::Suppressed {
                mutation_token: "projection-token-1".to_owned(),
                normalized_path: "note.md".to_owned(),
            }
        );
    }
}
