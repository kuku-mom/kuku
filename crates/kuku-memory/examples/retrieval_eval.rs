//! Small reproducible lexical-search baseline. Uses only synthetic memories.
use kuku_memory::{Actor, Remember, Store};
use serde_json::json;

fn main() -> Result<(), String> {
    let directory = tempfile::tempdir().map_err(|e| e.to_string())?;
    let mut store = Store::open(directory.path())?;
    let actor = Actor {
        client: "evaluation".into(),
        scopes: vec!["project".into()],
        auto_scopes: vec!["project".into()],
    };
    let corpus = [
        ("답변 언어", "설명은 한국어로 작성한다."),
        ("Package manager", "Use pnpm for all workspaces."),
        ("Commit style", "Write commits in English and Korean."),
    ];
    let mut ids = Vec::new();
    for (index, (title, body)) in corpus.iter().enumerate() {
        let input: Remember = serde_json::from_value(json!({
            "request_id":format!("eval-{index}"),"scope":"project",
            "title":title,"body":body
        }))
        .map_err(|e| e.to_string())?;
        ids.push(store.remember(&actor, input)?.id);
    }
    let questions = [
        ("어떤 언어로 설명하나요?", "한국어", "한국어", 0),
        ("Which language for explanations?", "Korean", "한국어", 0),
        ("Which package manager?", "package", "pnpm", 1),
        ("패키지 관리자는?", "패키지", "pnpm", 1),
        ("How should I write commits?", "commit", "commit", 2),
        ("커밋 작성 규칙은?", "커밋", "commit", 2),
    ];
    let mut direct_hits = 0;
    let mut retry_hits = 0;
    let mut cases = Vec::new();
    for (question, query, retry, expected) in questions {
        let started = std::time::Instant::now();
        let direct = store.search(&actor, query, Some("project"), 5)?;
        let hit = direct.iter().any(|m| m.id == ids[expected]);
        let retried = if hit {
            true
        } else {
            store
                .search(&actor, retry, Some("project"), 5)?
                .iter()
                .any(|m| m.id == ids[expected])
        };
        direct_hits += usize::from(hit);
        retry_hits += usize::from(retried);
        cases.push(json!({"question":question,"query":query,"retry":retry,
            "direct_hit_at_5":hit,"after_retry_hit_at_5":retried,
            "duration_us":started.elapsed().as_micros()}));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "corpus":"three synthetic memories; not a production quality estimate",
            "questions":cases,"direct_hits":direct_hits,"after_retry_hits":retry_hits,
            "total":questions.len()
        }))
        .map_err(|e| e.to_string())?
    );
    Ok(())
}
