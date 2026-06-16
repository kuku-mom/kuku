use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileCreate {
    pub stable_file_id: String,
    pub incarnation_id: String,
    pub display_path: String,
    pub text_doc_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob_ref: Option<String>,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MaterializedFile {
    pub stable_file_id: String,
    pub incarnation_id: String,
    pub display_path: String,
    pub normalized_path: String,
    pub state: FileState,
    pub text_doc_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tombstone_content: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileState {
    Active,
    Tombstoned,
}

impl FileState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            FileState::Active => "active",
            FileState::Tombstoned => "tombstoned",
        }
    }

    pub(crate) fn from_str(value: &str) -> Self {
        match value {
            "tombstoned" => FileState::Tombstoned,
            _ => FileState::Active,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MaterializeIssue {
    PathConflict {
        normalized_path: String,
        file_ids: Vec<String>,
    },
    CaseConflict {
        normalized_path: String,
        display_paths: Vec<String>,
        file_ids: Vec<String>,
    },
    DeleteEditConflict {
        file_id: String,
        display_path: String,
        text_doc_id: String,
        tombstone_content: String,
        current_content: String,
    },
    MissingTextDoc {
        file_id: String,
        text_doc_id: String,
    },
    MissingBlob {
        file_id: String,
        blob_ref: String,
    },
    ScalarConflict {
        file_id: String,
        field: String,
        values: Vec<String>,
    },
}

impl MaterializeIssue {
    pub(crate) fn blocks_projection(&self) -> bool {
        true
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MaterializedVault {
    pub files: BTreeMap<String, MaterializedFile>,
    pub issues: Vec<MaterializeIssue>,
    pub projection_plan: ProjectionPlan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectionPlan {
    pub blocked: bool,
    pub steps: Vec<ProjectionStep>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProjectionStep {
    Write {
        file_id: String,
        path: String,
        normalized_path: String,
        text_doc_id: String,
        content: String,
    },
    Tombstone {
        file_id: String,
        path: String,
        normalized_path: String,
    },
    Blocked {
        issue: MaterializeIssue,
    },
}
