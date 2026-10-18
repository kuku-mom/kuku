//! Task facts and reusable experiences share one atomic, versioned checkpoint.
//! Engines produce candidates; Store remains the authority for writes and access.
use crate::{Memory, Remember, Result, valid_id};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, schemars::JsonSchema, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Experience {
    pub conditions: String,
    pub method: String,
    pub result: String,
    pub outcome: String,
}

#[derive(Clone, Debug, schemars::JsonSchema, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ProjectRecord {
    pub task_id: String,
    pub goal: String,
    pub state: String,
    #[serde(default)]
    pub decisions: Vec<String>,
    #[serde(default)]
    pub open_questions: Vec<String>,
    #[serde(default)]
    pub next_actions: Vec<String>,
    #[serde(default)]
    pub experiences: Vec<Experience>,
    pub occurred_at: String,
}
impl ProjectRecord {
    pub fn validate(&self) -> Result<()> {
        if !valid_id(&self.task_id)
            || chrono::DateTime::parse_from_rfc3339(&self.occurred_at).is_err()
            || self.goal.trim().is_empty()
            || self.state.trim().is_empty()
            || self.decisions.len() > 20
            || self.open_questions.len() > 20
            || self.next_actions.len() > 20
            || self.experiences.len() > 10
            || serde_json::to_string(self)
                .map_err(|e| e.to_string())?
                .chars()
                .count()
                > 16000
        {
            return Err("Invalid project record".into());
        }
        for e in &self.experiences {
            if !["success", "failure", "unverified"].contains(&e.outcome.as_str())
                || e.conditions.trim().is_empty()
                || e.method.trim().is_empty()
                || e.result.trim().is_empty()
            {
                return Err(
                    "Experience requires conditions, method, result and a valid outcome".into(),
                );
            }
        }
        Ok(())
    }
    pub fn body(&self) -> String {
        let mut body = format!(
            "Goal: {}\nCurrent state: {}\nOccurred: {}\n",
            self.goal, self.state, self.occurred_at
        );
        for (label, values) in [
            ("Decisions", &self.decisions),
            ("Open questions", &self.open_questions),
            ("Suggested next actions", &self.next_actions),
        ] {
            body.push_str(&format!("\n{label}:\n"));
            for value in values {
                body.push_str(&format!("- {value}\n"));
            }
        }
        for e in &self.experiences {
            body.push_str(&format!(
                "\nExperience ({}):\nConditions: {}\nMethod: {}\nResult: {}\n",
                e.outcome, e.conditions, e.method, e.result
            ));
        }
        body
    }
}

#[derive(Clone, Debug, schemars::JsonSchema, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    pub request_id: String,
    pub scope: String,
    pub title: String,
    pub record: ProjectRecord,
    pub id: Option<String>,
    pub expected_version: Option<u64>,
    #[serde(default)]
    pub source_refs: Option<Vec<crate::SourceRef>>,
    pub expires_at: Option<String>,
}
impl Checkpoint {
    pub fn into_remember(self) -> Result<Remember> {
        self.record.validate()?;
        Ok(Remember {
            request_id: self.request_id,
            scope: self.scope,
            title: self.title,
            body: self.record.body(),
            record: Some(self.record),
            id: self.id,
            expected_version: self.expected_version,
            kind: Some("project_checkpoint".into()),
            tags: None,
            source_refs: self.source_refs,
            expires_at: self.expires_at,
        })
    }
}

/// Called only with records already filtered by the authoritative store.
/// Full records are never silently truncated into misleading partial facts.
pub fn context(records: &[Memory], max_chars: usize) -> Value {
    let budget = if max_chars == 0 {
        6000
    } else {
        max_chars.clamp(256, 12000)
    };
    let mut selected = Vec::new();
    let mut omitted = Vec::new();
    let mut used = 0;
    for m in records {
        let Some(record) = &m.record else { continue };
        let entry = json!({"id":m.id,"version":m.version,"scope":m.scope,"record":record});
        let size = entry.to_string().chars().count();
        if used + size > budget {
            omitted.push(m.id.clone());
            continue;
        }
        used += size;
        selected.push(entry);
    }
    json!({"checkpoints":selected,"omitted_ids":omitted,"note":"Independent records are not automatically reconciled. Next actions are suggestions; verify current project state."})
}
