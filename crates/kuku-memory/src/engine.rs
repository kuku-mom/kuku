//! Candidate-only engine boundary. No filesystem, credentials or write authority.
use crate::{Memory, Result};
use serde_json::Value;

pub trait MemoryEngine {
    /// Parse the configured model's bounded completion, not untrusted instructions.
    fn extract(&self, completion: &str) -> Result<Vec<Value>>;
    /// Return potential conflicts for review, never apply a merge.
    fn reconcile(&self, candidate: &Value, authorized: &[Memory]) -> Vec<String>;
    /// Rank only candidates already filtered by the authoritative store.
    fn rank(&self, query: &str, authorized: Vec<Memory>) -> Vec<Memory>;
}
pub struct NativeMemoryEngine;
impl MemoryEngine for NativeMemoryEngine {
    fn extract(&self, completion: &str) -> Result<Vec<Value>> {
        if completion.len() > 100000 {
            return Err("Extraction output too large".into());
        }
        let text = completion
            .trim()
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();
        let values: Vec<Value> =
            serde_json::from_str(text).map_err(|_| "Model returned invalid memory candidates")?;
        if values.len() > 20
            || values.iter().any(|v| {
                !v.is_object()
                    || v["title"]
                        .as_str()
                        .is_none_or(|s| s.trim().is_empty() || s.chars().count() > 160)
                    || v["body"]
                        .as_str()
                        .is_none_or(|s| s.trim().is_empty() || s.chars().count() > 20000)
            })
        {
            return Err("Invalid memory candidates".into());
        }
        Ok(values)
    }
    fn reconcile(&self, candidate: &Value, authorized: &[Memory]) -> Vec<String> {
        let title = candidate["title"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_lowercase();
        authorized
            .iter()
            .filter(|m| m.title.trim().to_lowercase() == title)
            .map(|m| m.id.clone())
            .collect()
    }
    fn rank(&self, query: &str, authorized: Vec<Memory>) -> Vec<Memory> {
        // Reciprocal rank fusion of lexical rank and exact tag matches. No model required.
        let terms: Vec<_> = query.split_whitespace().map(str::to_lowercase).collect();
        if terms.is_empty() {
            return authorized;
        }
        let mut tag_rank = 0;
        let mut ranked: Vec<_> = authorized
            .into_iter()
            .enumerate()
            .map(|(i, m)| {
                let mut score = 1.0 / (61.0 + i as f64);
                if m.tags.iter().any(|tag| terms.contains(&tag.to_lowercase())) {
                    tag_rank += 1;
                    score += 1.0 / (60.0 + tag_rank as f64);
                }
                (m, score, i)
            })
            .collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.2.cmp(&b.2)));
        ranked.into_iter().map(|(m, _, _)| m).collect()
    }
}
