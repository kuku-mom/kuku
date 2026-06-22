use std::path::Path;

use kuku_ai::{MutationOp, MutationPlan};

use crate::vault::checksum::compute_checksum;

use super::project_model::ProjectFolder;

const STANDARD_FILE_TEMPLATES: [(&str, &str); 3] = [
    (
        "PROJECT.md",
        "# {folder}\n\n## Purpose\n\nDescribe what this folder is responsible for.\n",
    ),
    (
        "NEXT.md",
        "# Next\n\n- [ ] Capture the next reviewed action.\n",
    ),
    (
        "AGENTS.md",
        "# Agents\n\n- Read PROJECT.md and NEXT.md before proposing changes.\n- Use Kuku approval for Folder Agent memory changes.\n",
    ),
];
const STANDARD_DIRS: [&str; 3] = ["Decisions", "Meetings", "Proposals"];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectMemoryKind {
    Decision,
    Meeting,
}

pub async fn build_scaffold_plan(
    root: &Path,
    folder: &ProjectFolder,
) -> Result<Option<MutationPlan>, String> {
    ensure_project_dir(root, folder).await?;
    let mut operations = Vec::new();

    for (name, template) in STANDARD_FILE_TEMPLATES {
        let path = project_path(folder, name);
        match path_kind(root, &path).await? {
            PathKind::Missing => operations.push(MutationOp::CreateFile {
                path,
                content: template.replace("{folder}", folder.as_str()),
            }),
            PathKind::File => {}
            PathKind::Directory => return Err(format!("{path} is a directory")),
        }
    }

    for dir in STANDARD_DIRS {
        let path = project_path(folder, dir);
        match path_kind(root, &path).await? {
            PathKind::Missing => operations.push(MutationOp::CreateDirectory { path }),
            PathKind::Directory => {}
            PathKind::File => return Err(format!("{path} is a file")),
        }
    }

    if operations.is_empty() {
        return Ok(None);
    }
    Ok(Some(MutationPlan {
        summary: format!("Set up Folder Agent files for {}", folder.as_str()),
        operations,
    }))
}

pub async fn build_next_steps_plan(
    root: &Path,
    folder: &ProjectFolder,
    content: &str,
    summary: Option<&str>,
) -> Result<MutationPlan, String> {
    ensure_project_dir(root, folder).await?;
    let path = project_path(folder, "NEXT.md");
    let summary = summary
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Update NEXT.md")
        .to_string();

    let operation = match path_kind(root, &path).await? {
        PathKind::Missing => MutationOp::CreateFile {
            path,
            content: content.to_string(),
        },
        PathKind::File => {
            let current = tokio::fs::read_to_string(root.join(&path))
                .await
                .map_err(|error| format!("Failed to read {path}: {error}"))?;
            MutationOp::ReplaceFile {
                path,
                content: content.to_string(),
                expected_checksum: compute_checksum(&current),
                before_excerpt: Some(preview_excerpt(&current)),
            }
        }
        PathKind::Directory => return Err(format!("{path} is a directory")),
    };

    Ok(MutationPlan {
        summary,
        operations: vec![operation],
    })
}

pub async fn build_memory_markdown_plan(
    root: &Path,
    folder: &ProjectFolder,
    kind: ProjectMemoryKind,
    title: &str,
    body: &str,
    date: &str,
) -> Result<MutationPlan, String> {
    ensure_project_dir(root, folder).await?;
    let dir = project_path(folder, kind.dir_name());
    let mut operations = Vec::new();
    match path_kind(root, &dir).await? {
        PathKind::Missing => operations.push(MutationOp::CreateDirectory { path: dir.clone() }),
        PathKind::Directory => {}
        PathKind::File => return Err(format!("{dir} is a file")),
    }

    let title = title.trim();
    if title.is_empty() {
        return Err("Missing title".to_string());
    }
    let body = body.trim();
    if body.is_empty() {
        return Err("Missing content".to_string());
    }
    let path = available_memory_path(root, folder, kind, date, title).await?;
    operations.push(MutationOp::CreateFile {
        path,
        content: memory_markdown(kind, title, body, date),
    });

    Ok(MutationPlan {
        summary: format!("Record {}: {title}", kind.summary_label()),
        operations,
    })
}

impl ProjectMemoryKind {
    fn dir_name(self) -> &'static str {
        match self {
            Self::Decision => "Decisions",
            Self::Meeting => "Meetings",
        }
    }

    fn summary_label(self) -> &'static str {
        match self {
            Self::Decision => "decision",
            Self::Meeting => "meeting summary",
        }
    }

    fn type_label(self) -> &'static str {
        match self {
            Self::Decision => "Decision",
            Self::Meeting => "Meeting Summary",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PathKind {
    Missing,
    File,
    Directory,
}

async fn ensure_project_dir(root: &Path, folder: &ProjectFolder) -> Result<(), String> {
    match path_kind(root, folder.as_str()).await? {
        PathKind::Directory => Ok(()),
        PathKind::Missing => Err(format!("Project folder {} does not exist", folder.as_str())),
        PathKind::File => Err(format!("Project folder {} is a file", folder.as_str())),
    }
}

async fn path_kind(root: &Path, relative: &str) -> Result<PathKind, String> {
    match tokio::fs::symlink_metadata(root.join(relative)).await {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(format!("{relative} is a symlink, which is not allowed"))
        }
        Ok(metadata) if metadata.is_file() => Ok(PathKind::File),
        Ok(metadata) if metadata.is_dir() => Ok(PathKind::Directory),
        Ok(_) => Err(format!("{relative} is not a regular file or directory")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(PathKind::Missing),
        Err(error) => Err(format!("Failed to inspect {relative}: {error}")),
    }
}

async fn available_memory_path(
    root: &Path,
    folder: &ProjectFolder,
    kind: ProjectMemoryKind,
    date: &str,
    title: &str,
) -> Result<String, String> {
    let slug = slugify(title);
    for suffix in 0..100 {
        let stem = if suffix == 0 {
            format!("{date}-{slug}")
        } else {
            format!("{date}-{slug}-{}", suffix + 1)
        };
        let relative = project_path(folder, &format!("{}/{}.md", kind.dir_name(), stem));
        if matches!(path_kind(root, &relative).await?, PathKind::Missing) {
            return Ok(relative);
        }
    }
    Err(format!(
        "Could not find an available {} path",
        kind.dir_name()
    ))
}

fn memory_markdown(kind: ProjectMemoryKind, title: &str, body: &str, date: &str) -> String {
    format!(
        "# {title}\n\n- Date: {date}\n- Type: {}\n\n{body}\n",
        kind.type_label()
    )
}

fn slugify(value: &str) -> String {
    let mut output = String::new();
    let mut previous_dash = false;
    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            output.push(ch.to_ascii_lowercase());
            previous_dash = false;
        } else if !previous_dash && !output.is_empty() {
            output.push('-');
            previous_dash = true;
        }
    }
    while output.ends_with('-') {
        output.pop();
    }
    if output.is_empty() {
        "untitled".to_string()
    } else {
        output
    }
}

fn project_path(folder: &ProjectFolder, child: &str) -> String {
    format!("{}/{}", folder.as_str(), child.trim_start_matches('/'))
}

fn preview_excerpt(text: &str) -> String {
    text.chars().take(240).collect()
}
