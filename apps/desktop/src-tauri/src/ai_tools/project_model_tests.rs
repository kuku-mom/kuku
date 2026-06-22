use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use kuku_ai::MutationOp;

use crate::vault::checksum::compute_checksum;

use super::project_context::{build_project_context, build_project_next_steps, discover_projects};
use super::project_memory_proposal::{
    ProjectMemoryKind, build_memory_markdown_plan, build_next_steps_plan, build_scaffold_plan,
};
use super::project_model::{DEFAULT_CONTEXT_MAX_CHARS, ProjectFolder};
use super::project_proposal::build_handoff_proposal;

struct TempVault {
    root: PathBuf,
}

impl TempVault {
    fn new(name: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "kuku-project-model-{name}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("temp vault should be created");
        Self { root }
    }

    fn path(&self) -> &Path {
        &self.root
    }

    fn write(&self, relative: &str, content: &str) {
        let path = self.root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent directories should be created");
        }
        fs::write(path, content).expect("fixture file should be written");
    }
}

impl Drop for TempVault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn block_on<T>(future: impl Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

#[test]
fn project_folder_rejects_paths_outside_first_level_folder() {
    assert!(ProjectFolder::parse("").is_err());
    assert!(ProjectFolder::parse("../Kuku").is_err());
    assert!(ProjectFolder::parse("Kuku/Nested").is_err());
    assert!(ProjectFolder::parse(".Hidden").is_err());
    assert_eq!(
        ProjectFolder::parse(" Kuku ")
            .expect("plain folder should parse")
            .as_str(),
        "Kuku"
    );
}

#[test]
fn discover_projects_detects_first_level_folders_and_standard_files() {
    let vault = TempVault::new("discover");
    vault.write("Kuku/PROJECT.md", "# Kuku");
    vault.write("Kuku/NEXT.md", "- Ship project context");
    vault.write("Kuku/AGENTS.md", "Use proposals");
    vault.write("Kuku/Decisions/2026-06-22-folder-agent.md", "# Decision");
    vault.write("Research/Meetings/2026-06-21-sync.md", "# Sync");
    vault.write(".Hidden/PROJECT.md", "# Hidden");
    vault.write("Loose.md", "# Loose");

    let projects = block_on(discover_projects(vault.path())).expect("projects should load");

    assert_eq!(
        projects
            .iter()
            .map(|project| project.folder.as_str())
            .collect::<Vec<_>>(),
        vec!["Kuku", "Research"]
    );
    let kuku = projects
        .iter()
        .find(|project| project.folder == "Kuku")
        .expect("Kuku project should exist");
    assert_eq!(
        kuku.source_files,
        vec!["Kuku/PROJECT.md", "Kuku/NEXT.md", "Kuku/AGENTS.md"]
    );
    assert!(kuku.has_project);
    assert!(kuku.has_next);
    assert!(kuku.has_agents);
    assert_eq!(kuku.recent_decision_count, 1);
    assert_eq!(kuku.recent_meeting_count, 0);
}

#[test]
fn build_project_context_prioritizes_standard_files_and_recent_activity() {
    let vault = TempVault::new("context");
    vault.write("Kuku/PROJECT.md", "# Project\nIdentity");
    vault.write("Kuku/NEXT.md", "# Next\nDo this next");
    vault.write("Kuku/AGENTS.md", "# Agents\nRead-only first");
    vault.write("Kuku/Decisions/2026-06-20-old.md", "# Old");
    vault.write("Kuku/Decisions/2026-06-22-new.md", "# New");
    vault.write("Kuku/Meetings/2026-06-22-sync.md", "# Sync");

    let folder = ProjectFolder::parse("Kuku").expect("folder should parse");
    let bundle = block_on(build_project_context(
        vault.path(),
        &folder,
        DEFAULT_CONTEXT_MAX_CHARS,
    ))
    .expect("context should load");

    assert_eq!(bundle.scope, "folder");
    assert_eq!(bundle.folder, "Kuku");
    assert_eq!(
        bundle.source_files,
        vec!["Kuku/PROJECT.md", "Kuku/NEXT.md", "Kuku/AGENTS.md"]
    );
    assert_eq!(
        bundle.recent_decisions,
        vec![
            "Kuku/Decisions/2026-06-22-new.md",
            "Kuku/Decisions/2026-06-20-old.md"
        ]
    );
    assert_eq!(
        bundle.recent_meetings,
        vec!["Kuku/Meetings/2026-06-22-sync.md"]
    );
    assert_eq!(bundle.mode, "read_or_propose_only");
    assert_eq!(
        bundle
            .files
            .iter()
            .map(|file| (file.role.as_str(), file.path.as_str()))
            .collect::<Vec<_>>(),
        vec![
            ("project", "Kuku/PROJECT.md"),
            ("next", "Kuku/NEXT.md"),
            ("agents", "Kuku/AGENTS.md"),
            ("decision", "Kuku/Decisions/2026-06-22-new.md"),
            ("decision", "Kuku/Decisions/2026-06-20-old.md"),
            ("meeting", "Kuku/Meetings/2026-06-22-sync.md"),
        ]
    );
}

#[test]
fn build_project_next_steps_reads_next_markdown_without_mutating_vault() {
    let vault = TempVault::new("next");
    vault.write("Kuku/NEXT.md", "# Next\n- Implement folder agents");
    let folder = ProjectFolder::parse("Kuku").expect("folder should parse");

    let next =
        block_on(build_project_next_steps(vault.path(), &folder)).expect("next steps should load");

    assert!(next.exists);
    assert_eq!(next.path, "Kuku/NEXT.md");
    assert_eq!(
        next.content.as_deref(),
        Some("# Next\n- Implement folder agents")
    );
}

#[test]
fn build_handoff_proposal_targets_project_proposals_folder() {
    let vault = TempVault::new("handoff");
    vault.write("Kuku/PROJECT.md", "# Kuku");
    let folder = ProjectFolder::parse("Kuku").expect("folder should parse");
    let bundle = block_on(build_project_context(
        vault.path(),
        &folder,
        DEFAULT_CONTEXT_MAX_CHARS,
    ))
    .expect("empty context should still serialize");

    let proposal = build_handoff_proposal(&folder, "codex", &bundle, "2026-06-22");

    assert_eq!(
        proposal.path,
        "Kuku/Proposals/2026-06-22-agent-handoff-codex.proposal.md"
    );
    assert!(proposal.content.contains("# Agent Handoff: Kuku"));
    assert!(proposal.content.contains("## Constraints"));
    assert!(proposal.content.contains("read_or_propose_only"));
}

#[test]
fn build_scaffold_plan_only_creates_missing_folder_agent_files() {
    let vault = TempVault::new("scaffold");
    vault.write("Kuku/PROJECT.md", "# Kuku");
    let folder = ProjectFolder::parse("Kuku").expect("folder should parse");

    let plan = block_on(build_scaffold_plan(vault.path(), &folder))
        .expect("scaffold should inspect folder")
        .expect("missing files should produce a plan");

    assert_eq!(plan.summary, "Set up Folder Agent files for Kuku");
    let paths = plan
        .operations
        .iter()
        .map(|operation| match operation {
            MutationOp::CreateFile { path, .. } => format!("file:{path}"),
            MutationOp::CreateDirectory { path } => format!("dir:{path}"),
            other => format!("other:{other:?}"),
        })
        .collect::<Vec<_>>();
    assert_eq!(
        paths,
        vec![
            "file:Kuku/NEXT.md",
            "file:Kuku/AGENTS.md",
            "dir:Kuku/Decisions",
            "dir:Kuku/Meetings",
            "dir:Kuku/Proposals"
        ]
    );
}

#[test]
fn build_next_steps_plan_replaces_existing_next_with_checksum() {
    let vault = TempVault::new("next-proposal");
    vault.write("Kuku/NEXT.md", "# Next\n- Old");
    let folder = ProjectFolder::parse("Kuku").expect("folder should parse");

    let plan = block_on(build_next_steps_plan(
        vault.path(),
        &folder,
        "# Next\n- Ship folder scope",
        Some("Update folder scope work"),
    ))
    .expect("next plan should build");

    assert_eq!(plan.summary, "Update folder scope work");
    assert_eq!(plan.operations.len(), 1);
    match &plan.operations[0] {
        MutationOp::ReplaceFile {
            path,
            content,
            expected_checksum,
            before_excerpt,
        } => {
            assert_eq!(path, "Kuku/NEXT.md");
            assert_eq!(content, "# Next\n- Ship folder scope");
            assert_eq!(expected_checksum, &compute_checksum("# Next\n- Old"));
            assert_eq!(before_excerpt.as_deref(), Some("# Next\n- Old"));
        }
        other => panic!("expected ReplaceFile, got {other:?}"),
    }
}

#[test]
fn build_memory_markdown_plan_creates_dated_decision_path() {
    let vault = TempVault::new("decision-proposal");
    vault.write("Kuku/PROJECT.md", "# Kuku");
    let folder = ProjectFolder::parse("Kuku").expect("folder should parse");

    let plan = block_on(build_memory_markdown_plan(
        vault.path(),
        &folder,
        ProjectMemoryKind::Decision,
        "Folder Agents",
        "Use manual review for Folder Agent memory writes.",
        "2026-06-22",
    ))
    .expect("decision plan should build");

    assert_eq!(plan.summary, "Record decision: Folder Agents");
    assert_eq!(plan.operations.len(), 2);
    assert!(matches!(
        &plan.operations[0],
        MutationOp::CreateDirectory { path } if path == "Kuku/Decisions"
    ));
    match &plan.operations[1] {
        MutationOp::CreateFile { path, content } => {
            assert_eq!(path, "Kuku/Decisions/2026-06-22-folder-agents.md");
            assert!(content.contains("# Folder Agents"));
            assert!(content.contains("Use manual review"));
        }
        other => panic!("expected CreateFile, got {other:?}"),
    }
}
