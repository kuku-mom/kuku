use std::path::Path;

use crate::vault::should_ignore_path;

use super::project_model::{
    ProjectContextBundle, ProjectContextFile, ProjectContextLimits, ProjectFolder,
    ProjectNextSteps, ProjectSummary,
};

const CONTEXT_MAX_TOKENS: u32 = 24_000;
const RECENT_MARKDOWN_LIMIT: usize = 3;
const STANDARD_FILES: [(&str, &str); 3] = [
    ("PROJECT.md", "project"),
    ("NEXT.md", "next"),
    ("AGENTS.md", "agents"),
];

pub async fn discover_projects(root: &Path) -> Result<Vec<ProjectSummary>, String> {
    let mut reader = tokio::fs::read_dir(root)
        .await
        .map_err(|error| format!("Failed to read vault root {}: {error}", root.display()))?;
    let mut projects = Vec::new();

    while let Some(entry) = reader
        .next_entry()
        .await
        .map_err(|error| format!("Failed to read vault root {}: {error}", root.display()))?
    {
        let name = entry.file_name().to_string_lossy().to_string();
        if should_ignore_path(Path::new(&name)) {
            continue;
        }
        let file_type = entry
            .file_type()
            .await
            .map_err(|error| format!("Failed to inspect {}: {error}", entry.path().display()))?;
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        let Ok(folder) = ProjectFolder::parse(&name) else {
            continue;
        };
        projects.push(build_project_summary(root, &folder).await?);
    }

    projects.sort_by(|left, right| {
        left.folder
            .to_ascii_lowercase()
            .cmp(&right.folder.to_ascii_lowercase())
            .then_with(|| left.folder.cmp(&right.folder))
    });
    Ok(projects)
}

pub async fn build_project_context(
    root: &Path,
    folder: &ProjectFolder,
    max_chars: usize,
) -> Result<ProjectContextBundle, String> {
    ensure_project_dir(root, folder).await?;

    let mut source_files = Vec::new();
    let mut missing_files = Vec::new();
    for (name, _) in STANDARD_FILES {
        let relative = project_relative_path(folder, name);
        if regular_file_exists(&root.join(&relative)).await? {
            source_files.push(relative);
        } else {
            missing_files.push(relative);
        }
    }

    let recent_decisions =
        recent_markdown_files(root, folder, "Decisions", RECENT_MARKDOWN_LIMIT).await?;
    let recent_meetings =
        recent_markdown_files(root, folder, "Meetings", RECENT_MARKDOWN_LIMIT).await?;
    let mut remaining = max_chars;
    let mut files = Vec::new();

    for (name, role) in STANDARD_FILES {
        let relative = project_relative_path(folder, name);
        if source_files.iter().any(|path| path == &relative) {
            push_context_file(root, &relative, role, &mut remaining, &mut files).await?;
        }
    }
    for path in &recent_decisions {
        push_context_file(root, path, "decision", &mut remaining, &mut files).await?;
    }
    for path in &recent_meetings {
        push_context_file(root, path, "meeting", &mut remaining, &mut files).await?;
    }

    Ok(ProjectContextBundle {
        scope: "folder".to_string(),
        folder: folder.as_str().to_string(),
        source_files,
        recent_decisions,
        recent_meetings,
        missing_files,
        limits: ProjectContextLimits {
            max_tokens: CONTEXT_MAX_TOKENS,
            max_chars,
        },
        mode: "read_or_propose_only".to_string(),
        files,
    })
}

pub async fn build_project_next_steps(
    root: &Path,
    folder: &ProjectFolder,
) -> Result<ProjectNextSteps, String> {
    ensure_project_dir(root, folder).await?;
    let path = project_relative_path(folder, "NEXT.md");
    if !regular_file_exists(&root.join(&path)).await? {
        return Ok(ProjectNextSteps {
            folder: folder.as_str().to_string(),
            path,
            exists: false,
            content: None,
        });
    }
    let content = tokio::fs::read_to_string(root.join(&path))
        .await
        .map_err(|error| format!("Failed to read {path}: {error}"))?;

    Ok(ProjectNextSteps {
        folder: folder.as_str().to_string(),
        path,
        exists: true,
        content: Some(content),
    })
}

async fn build_project_summary(
    root: &Path,
    folder: &ProjectFolder,
) -> Result<ProjectSummary, String> {
    let mut source_files = Vec::new();
    for (name, _) in STANDARD_FILES {
        let relative = project_relative_path(folder, name);
        if regular_file_exists(&root.join(&relative)).await? {
            source_files.push(relative);
        }
    }

    Ok(ProjectSummary {
        folder: folder.as_str().to_string(),
        path: folder.as_str().to_string(),
        has_project: source_files
            .iter()
            .any(|path| path.ends_with("/PROJECT.md")),
        has_next: source_files.iter().any(|path| path.ends_with("/NEXT.md")),
        has_agents: source_files.iter().any(|path| path.ends_with("/AGENTS.md")),
        source_files,
        recent_decision_count: recent_markdown_files(root, folder, "Decisions", usize::MAX)
            .await?
            .len(),
        recent_meeting_count: recent_markdown_files(root, folder, "Meetings", usize::MAX)
            .await?
            .len(),
    })
}

async fn ensure_project_dir(root: &Path, folder: &ProjectFolder) -> Result<(), String> {
    let path = root.join(folder.as_str());
    let metadata = tokio::fs::symlink_metadata(&path).await.map_err(|error| {
        format!(
            "Project folder {} is not readable: {error}",
            folder.as_str()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "Project folder {} is not a directory",
            folder.as_str()
        ));
    }
    Ok(())
}

async fn regular_file_exists(path: &Path) -> Result<bool, String> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => Ok(metadata.is_file() && !metadata.file_type().is_symlink()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Failed to inspect {}: {error}", path.display())),
    }
}

async fn regular_dir_exists(path: &Path) -> Result<bool, String> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => Ok(metadata.is_dir() && !metadata.file_type().is_symlink()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Failed to inspect {}: {error}", path.display())),
    }
}

async fn recent_markdown_files(
    root: &Path,
    folder: &ProjectFolder,
    dir_name: &str,
    limit: usize,
) -> Result<Vec<String>, String> {
    let dir = root.join(folder.as_str()).join(dir_name);
    if !regular_dir_exists(&dir).await? {
        return Ok(Vec::new());
    }

    let mut reader = tokio::fs::read_dir(&dir)
        .await
        .map_err(|error| format!("Failed to read {}: {error}", dir.display()))?;
    let mut files = Vec::new();
    while let Some(entry) = reader
        .next_entry()
        .await
        .map_err(|error| format!("Failed to read {}: {error}", dir.display()))?
    {
        let name = entry.file_name().to_string_lossy().to_string();
        if should_ignore_path(Path::new(&name)) || !name.ends_with(".md") {
            continue;
        }
        let file_type = entry
            .file_type()
            .await
            .map_err(|error| format!("Failed to inspect {}: {error}", entry.path().display()))?;
        if file_type.is_file() && !file_type.is_symlink() {
            files.push(project_relative_path(folder, &format!("{dir_name}/{name}")));
        }
    }
    files.sort_by(|left, right| right.cmp(left));
    files.truncate(limit);
    Ok(files)
}

async fn push_context_file(
    root: &Path,
    relative: &str,
    role: &str,
    remaining: &mut usize,
    files: &mut Vec<ProjectContextFile>,
) -> Result<(), String> {
    let content = tokio::fs::read_to_string(root.join(relative))
        .await
        .map_err(|error| format!("Failed to read {relative}: {error}"))?;
    let content_len = content.chars().count();
    let selected = content.chars().take(*remaining).collect::<String>();
    let selected_len = selected.chars().count();
    *remaining = remaining.saturating_sub(selected_len);
    files.push(ProjectContextFile {
        path: relative.to_string(),
        role: role.to_string(),
        content: selected,
        truncated: selected_len < content_len,
    });
    Ok(())
}

fn project_relative_path(folder: &ProjectFolder, child: &str) -> String {
    format!("{}/{}", folder.as_str(), child.trim_start_matches('/'))
}
