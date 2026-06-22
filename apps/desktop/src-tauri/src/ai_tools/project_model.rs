use std::path::{Component, Path};

use serde::Serialize;

use crate::vault::should_ignore_path;

pub const DEFAULT_CONTEXT_MAX_CHARS: usize = 24_000;

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ProjectFolder(String);

impl ProjectFolder {
    pub fn parse(raw: &str) -> Result<Self, String> {
        let value = raw.trim();
        if value.is_empty() {
            return Err("Folder is required".to_string());
        }
        if value.contains('\\') {
            return Err("Folder must be a first-level vault folder".to_string());
        }
        let path = Path::new(value);
        if path.is_absolute() {
            return Err("Folder must be vault-relative".to_string());
        }

        let mut folder: Option<String> = None;
        for component in path.components() {
            match component {
                Component::CurDir => {}
                Component::Normal(segment) if folder.is_none() => {
                    let Some(name) = segment.to_str() else {
                        return Err("Folder must be valid UTF-8".to_string());
                    };
                    folder = Some(name.to_string());
                }
                Component::Normal(_)
                | Component::ParentDir
                | Component::RootDir
                | Component::Prefix(_) => {
                    return Err("Folder must be a first-level vault folder".to_string());
                }
            }
        }

        let folder = folder.ok_or_else(|| "Folder is required".to_string())?;
        if should_ignore_path(Path::new(&folder)) {
            return Err("Folder is ignored by vault rules".to_string());
        }

        Ok(Self(folder))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub folder: String,
    pub path: String,
    pub has_project: bool,
    pub has_next: bool,
    pub has_agents: bool,
    pub source_files: Vec<String>,
    pub recent_decision_count: usize,
    pub recent_meeting_count: usize,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectContextFile {
    pub path: String,
    pub role: String,
    pub content: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectContextLimits {
    pub max_tokens: u32,
    pub max_chars: usize,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectContextBundle {
    pub scope: String,
    pub folder: String,
    pub source_files: Vec<String>,
    pub recent_decisions: Vec<String>,
    pub recent_meetings: Vec<String>,
    pub missing_files: Vec<String>,
    pub limits: ProjectContextLimits,
    pub mode: String,
    pub files: Vec<ProjectContextFile>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectNextSteps {
    pub folder: String,
    pub path: String,
    pub exists: bool,
    pub content: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct HandoffProposal {
    pub path: String,
    pub content: String,
}
