use super::project_model::{HandoffProposal, ProjectContextBundle, ProjectFolder};

pub fn build_handoff_proposal(
    folder: &ProjectFolder,
    target: &str,
    bundle: &ProjectContextBundle,
    date: &str,
) -> HandoffProposal {
    let path = format!(
        "{}/Proposals/{}-agent-handoff-{}.proposal.md",
        folder.as_str(),
        date,
        target
    );
    let mut content = format!(
        "# Agent Handoff: {}\n\n## Target\n{}\n\n## Goal\nContinue this folder's work using the Markdown context below.\n\n## Current State\nUse PROJECT.md, NEXT.md, AGENTS.md, recent Decisions, and recent Meetings as the source of truth.\n\n## Next Task\nStart from NEXT.md when present. If NEXT.md is missing, infer only from PROJECT.md and ask for a reviewed proposal before changing files.\n\n## Relevant Files\n{}\n\n## Constraints\n- Mode: {}\n- Read freely inside `{}/`.\n- Propose Markdown changes through Kuku's approval/diff flow before mutating vault files.\n- Keep all paths vault-relative.\n\n## Do Not Change\n- Do not write outside `{}/`.\n- Do not bypass the proposal approval path for decisions, NEXT updates, or AGENTS updates.\n\n## Suggested First Step\nCall `project_context` for `{}` and inspect the returned source files before planning edits.\n\n## Source Context\n",
        folder.as_str(),
        target,
        relevant_files(bundle),
        bundle.mode,
        folder.as_str(),
        folder.as_str(),
        folder.as_str(),
    );

    for file in &bundle.files {
        content.push_str(&format!(
            "\n### {} ({})\n\n```md\n{}\n```\n",
            file.path, file.role, file.content
        ));
    }

    HandoffProposal { path, content }
}

fn relevant_files(bundle: &ProjectContextBundle) -> String {
    let mut files = bundle.source_files.clone();
    files.extend(bundle.recent_decisions.iter().cloned());
    files.extend(bundle.recent_meetings.iter().cloned());
    if files.is_empty() {
        return "- No source files found".to_string();
    }
    files.sort();
    files
        .into_iter()
        .map(|path| format!("- {path}"))
        .collect::<Vec<_>>()
        .join("\n")
}
