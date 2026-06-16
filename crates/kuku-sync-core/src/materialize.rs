use std::collections::{BTreeMap, BTreeSet};

use crate::model::{FileState, MaterializeIssue, MaterializedFile, ProjectionPlan, ProjectionStep};

pub(crate) fn path_conflicts(files: &BTreeMap<String, MaterializedFile>) -> Vec<MaterializeIssue> {
    let mut by_path: BTreeMap<String, Vec<&MaterializedFile>> = BTreeMap::new();
    for file in files.values() {
        if file.state == FileState::Active {
            by_path
                .entry(file.normalized_path.clone())
                .or_default()
                .push(file);
        }
    }

    let mut issues = Vec::new();
    for (normalized_path, group) in by_path {
        if group.len() < 2 {
            continue;
        }

        let file_ids = group
            .iter()
            .map(|file| file.stable_file_id.clone())
            .collect::<Vec<_>>();
        let display_paths = group
            .iter()
            .map(|file| file.display_path.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();

        if display_paths.len() > 1 {
            issues.push(MaterializeIssue::CaseConflict {
                normalized_path: normalized_path.clone(),
                display_paths,
                file_ids: file_ids.clone(),
            });
        }
        issues.push(MaterializeIssue::PathConflict {
            normalized_path,
            file_ids,
        });
    }
    issues
}

pub(crate) fn build_projection_plan(
    files: &BTreeMap<String, MaterializedFile>,
    issues: &[MaterializeIssue],
) -> ProjectionPlan {
    let mut steps = issues
        .iter()
        .filter(|issue| issue.blocks_projection())
        .cloned()
        .map(|issue| ProjectionStep::Blocked { issue })
        .collect::<Vec<_>>();

    let blocked = !steps.is_empty();
    if !blocked {
        for file in files.values() {
            match file.state {
                FileState::Active => steps.push(ProjectionStep::Write {
                    file_id: file.stable_file_id.clone(),
                    path: file.display_path.clone(),
                    normalized_path: file.normalized_path.clone(),
                    text_doc_id: file.text_doc_id.clone(),
                    content: file.content.clone().unwrap_or_default(),
                }),
                FileState::Tombstoned => steps.push(ProjectionStep::Tombstone {
                    file_id: file.stable_file_id.clone(),
                    path: file.display_path.clone(),
                    normalized_path: file.normalized_path.clone(),
                }),
            }
        }
    }

    ProjectionPlan { blocked, steps }
}
