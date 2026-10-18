//! Versioned, scoped memory. Markdown remains editable; SQLite is a rebuildable
//! search index and a durable mutation journal, not a replacement for the vault.
use chrono::{DateTime, Utc};
use fs2::FileExt;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

pub mod checkpoint;
pub mod engine;
mod jobs;

pub type Result<T> = std::result::Result<T, String>;
fn now() -> String {
    Utc::now().to_rfc3339()
}
fn one() -> u64 {
    1
}
fn personal() -> String {
    "personal".into()
}
fn active() -> String {
    "active".into()
}
pub fn digest(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 160
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

#[derive(Clone, Debug, schemars::JsonSchema, Serialize, Deserialize, PartialEq)]
pub struct SourceRef {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
    #[serde(default = "now")]
    pub captured_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Memory {
    pub id: String,
    #[serde(default = "personal")]
    pub scope: String,
    #[serde(default)]
    pub client: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record: Option<checkpoint::ProjectRecord>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default = "active")]
    pub status: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub source_refs: Vec<SourceRef>,
    #[serde(default = "one")]
    pub version: u64,
    #[serde(default)]
    pub supersedes: Option<String>,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default = "now")]
    pub created_at: String,
    #[serde(default = "now")]
    pub updated_at: String,
    #[serde(default)]
    pub proposal_id: String,
    #[serde(default)]
    pub decision_document: String,
    #[serde(default)]
    pub shared: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restored_from: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Remember {
    pub request_id: String,
    pub scope: String,
    pub title: String,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record: Option<checkpoint::ProjectRecord>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub expected_version: Option<u64>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub source_refs: Option<Vec<SourceRef>>,
    #[serde(default)]
    pub expires_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Outcome {
    pub status: String,
    pub id: String,
    pub version: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Actor {
    pub client: String,
    pub scopes: Vec<String>,
    pub auto_scopes: Vec<String>,
}
impl Actor {
    pub fn permits(&self, scope: &str) -> bool {
        self.scopes.iter().any(|s| s == scope)
    }
}

pub fn validate(input: &Remember, actor: &Actor) -> Result<()> {
    if let Some(record) = &input.record {
        record.validate()?;
        if input.body.trim() != record.body().trim() {
            return Err("Checkpoint body must match its structured record".into());
        }
    }
    let tags = input.tags.as_deref().unwrap_or_default();
    let sources = input.source_refs.as_deref().unwrap_or_default();
    if !actor.permits(&input.scope) {
        return Err("Scope is not authorized".into());
    }
    if !valid_id(&input.request_id) || !valid_id(&input.scope) {
        return Err("Invalid request ID or scope".into());
    }
    if input
        .id
        .as_deref()
        .is_some_and(|s| !valid_id(s) || !s.starts_with("mem_"))
    {
        return Err("Invalid memory ID".into());
    }
    if input.id.is_some() != input.expected_version.is_some() {
        return Err("Updates require an ID and expected_version".into());
    }
    if input.title.trim().is_empty()
        || input.title.chars().count() > 160
        || input.body.trim().is_empty()
        || input.body.chars().count() > 20_000
    {
        return Err("Title or body is empty or too long".into());
    }
    if input
        .kind
        .as_deref()
        .is_some_and(|s| s.trim().is_empty() || s.chars().count() > 40)
        || tags.len() > 30
        || tags
            .iter()
            .any(|s| s.trim().is_empty() || s.chars().count() > 40)
        || sources.len() > 30
    {
        return Err("Invalid kind, tags, or source references".into());
    }
    for source in sources {
        if source.path.trim().is_empty()
            || source.path.len() > 2000
            || source.path.chars().any(char::is_control)
            || source
                .origin
                .as_ref()
                .is_some_and(|s| s.len() > 2000 || s.chars().any(char::is_control))
            || source
                .quote
                .as_ref()
                .is_some_and(|s| s.chars().count() > 4000)
            || source
                .title
                .as_ref()
                .is_some_and(|s| s.chars().count() > 160)
            || DateTime::parse_from_rfc3339(&source.captured_at).is_err()
        {
            return Err("Invalid source reference".into());
        }
    }
    if let Some(expiry) = &input.expires_at
        && DateTime::parse_from_rfc3339(expiry)
            .map_err(|_| "Invalid expiry")?
            .with_timezone(&Utc)
            <= Utc::now()
    {
        return Err("Expiry must be in the future".into());
    }
    Ok(())
}

pub struct Store {
    root: PathBuf,
    db: Connection,
    _lock: fs::File,
}
impl Store {
    pub fn open(root: &Path) -> Result<Self> {
        let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
        let base = root.join(".kuku/knowledge");
        safe_mkdir(&root, &base)?;
        let lock_path = base.join("memory.lock");
        ensure_safe(&root, &lock_path)?;
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_path)
            .map_err(|e| e.to_string())?;
        lock.try_lock_exclusive()
            .map_err(|_| "Memory is busy; retry the request")?;
        let db_path = base.join("memory.sqlite");
        ensure_safe(&root, &db_path)?;
        let db = Connection::open(db_path).map_err(|e| e.to_string())?;
        db.busy_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, scope TEXT NOT NULL, data TEXT NOT NULL, checksum TEXT NOT NULL DEFAULT '', dirty INTEGER NOT NULL DEFAULT 0);
          CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED,title,body,tags,tokenize='unicode61 remove_diacritics 2');
          CREATE TABLE IF NOT EXISTS changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL,client TEXT NOT NULL,before_data TEXT,after_data TEXT NOT NULL,created_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS receipts(client TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(client,request_id));
          CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,base_version INTEGER NOT NULL,data TEXT NOT NULL,request_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending');
          CREATE TABLE IF NOT EXISTS cloud_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);").map_err(|e| e.to_string())?;
        let mut store = Self {
            root,
            db,
            _lock: lock,
        };
        store.recover()?;
        store.reconcile()?;
        Ok(store)
    }

    pub fn read(&self, actor: &Actor, id: &str) -> Result<Memory> {
        let memory = self.get(id)?.ok_or("Memory not found")?;
        if !actor.permits(&memory.scope) || memory.status == "deleted" {
            return Err("Memory not found".into());
        }
        Ok(memory)
    }
    pub fn read_active(&self, actor: &Actor, id: &str) -> Result<Memory> {
        let m = self.read(actor, id)?;
        if m.status != "active"
            || m.expires_at.as_ref().is_some_and(|t| {
                DateTime::parse_from_rfc3339(t)
                    .map(|t| t.with_timezone(&Utc) <= Utc::now())
                    .unwrap_or(true)
            })
        {
            return Err("Memory is inactive or expired".into());
        }
        Ok(m)
    }
    fn get(&self, id: &str) -> Result<Option<Memory>> {
        let data: Option<String> = self
            .db
            .query_row("SELECT data FROM memories WHERE id=?1", [id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        data.map(|d| serde_json::from_str(&d).map_err(|e| e.to_string()))
            .transpose()
    }
    pub fn search(
        &self,
        actor: &Actor,
        query: &str,
        scope: Option<&str>,
        limit: usize,
    ) -> Result<Vec<Memory>> {
        self.search_filtered(actor, query, scope, limit, None, None)
    }
    pub fn search_filtered(
        &self,
        actor: &Actor,
        query: &str,
        scope: Option<&str>,
        limit: usize,
        task_id: Option<&str>,
        kind: Option<&str>,
    ) -> Result<Vec<Memory>> {
        if query.chars().count() > 500 {
            return Err("Query is too long".into());
        }
        if scope.is_some_and(|s| !actor.permits(s)) {
            return Err("Scope is not authorized".into());
        }
        let expression = query
            .split_whitespace()
            .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" OR ");
        let scopes = serde_json::to_string(&actor.scopes).map_err(|e| e.to_string())?;
        let mut stmt = self.db.prepare("SELECT m.data FROM memories m LEFT JOIN (SELECT id,bm25(memories_fts) rank FROM memories_fts WHERE memories_fts MATCH ?1) f ON f.id=m.id
          WHERE m.scope IN (SELECT value FROM json_each(?2)) AND (?3 IS NULL OR m.scope=?3)
          AND (?6 IS NULL OR json_extract(m.data,'$.record.task_id')=?6) AND (?7 IS NULL OR json_extract(m.data,'$.kind')=?7)
          AND json_extract(m.data,'$.status')='active' AND (json_extract(m.data,'$.expires_at') IS NULL OR julianday(json_extract(m.data,'$.expires_at'))>julianday('now'))
          AND (?4='' OR f.id IS NOT NULL OR instr(lower(json_extract(m.data,'$.title')),lower(?4))>0 OR instr(lower(json_extract(m.data,'$.body')),lower(?4))>0)
          ORDER BY CASE WHEN f.rank IS NULL THEN 1 ELSE 0 END,f.rank,json_extract(m.data,'$.updated_at') DESC LIMIT ?5").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(
                params![
                    if expression.is_empty() {
                        "\"\""
                    } else {
                        &expression
                    },
                    scopes,
                    scope,
                    query,
                    50,
                    task_id,
                    kind
                ],
                |r| r.get::<_, String>(0),
            )
            .map_err(|e| e.to_string())?;
        let records = rows
            .map(|r| {
                serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
            })
            .collect::<Result<Vec<Memory>>>()?;
        use engine::MemoryEngine;
        Ok(engine::NativeMemoryEngine
            .rank(query, records)
            .into_iter()
            .take(limit.clamp(1, 50))
            .collect())
    }

    pub fn remember(&mut self, actor: &Actor, input: Remember) -> Result<Outcome> {
        self.remember_in_scope(actor, input, false)
    }
    pub fn remember_in_scope(
        &mut self,
        actor: &Actor,
        input: Remember,
        share: bool,
    ) -> Result<Outcome> {
        validate(&input, actor)?;
        let fingerprint = digest(
            serde_json::to_string(&input)
                .map_err(|e| e.to_string())?
                .as_bytes(),
        );
        if let Some((previous, result)) = self
            .db
            .query_row(
                "SELECT fingerprint,result FROM receipts WHERE client=?1 AND request_id=?2",
                params![actor.client, input.request_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?
        {
            if previous != fingerprint {
                return Err("Request ID was already used with different content".into());
            }
            return serde_json::from_str(&result).map_err(|e| e.to_string());
        }
        let before = if let Some(id) = &input.id {
            Some(self.read(actor, id)?)
        } else {
            let data:Option<String>=self.db.query_row("SELECT data FROM memories WHERE scope=?1 AND lower(json_extract(data,'$.title'))=lower(?2) AND json_extract(data,'$.status')='active' ORDER BY json_extract(data,'$.updated_at') DESC LIMIT 1",params![input.scope,input.title],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
            data.map(|s| serde_json::from_str::<Memory>(&s).map_err(|e| e.to_string()))
                .transpose()?
        };
        if before.as_ref().is_some_and(|m| {
            m.record.is_some() && input.record.is_none() && m.body.trim() != input.body.trim()
        }) {
            return Err("Update structured checkpoints with memory_checkpoint".into());
        }
        if input.id.is_some()
            && before.as_ref().is_some_and(|m| {
                m.scope != input.scope || Some(m.version) != input.expected_version
            })
        {
            return Ok(Outcome {
                status: "conflict".into(),
                id: input.id.unwrap_or_default(),
                version: before.map(|m| m.version).unwrap_or(0),
                decision_path: None,
            });
        }
        if input.id.is_none()
            && let Some(existing) = &before
            && existing.body.trim() == input.body.trim()
            && existing.record == input.record
            && existing.expires_at == input.expires_at
        {
            let result = Outcome {
                status: "committed".into(),
                id: existing.id.clone(),
                version: existing.version,
                decision_path: None,
            };
            self.db
                .execute(
                    "INSERT INTO receipts VALUES(?1,?2,?3,?4)",
                    params![
                        actor.client,
                        input.request_id,
                        fingerprint,
                        serde_json::to_string(&result).map_err(|e| e.to_string())?
                    ],
                )
                .map_err(|e| e.to_string())?;
            return Ok(result);
        }
        if let (Some(old), Some(new)) = (
            before.as_ref().and_then(|m| m.record.as_ref()),
            input.record.as_ref(),
        ) && (old.task_id != new.task_id
            || DateTime::parse_from_rfc3339(&new.occurred_at).map_err(|e| e.to_string())?
                < DateTime::parse_from_rfc3339(&old.occurred_at).map_err(|e| e.to_string())?)
        {
            return Ok(Outcome {
                status: "conflict".into(),
                id: before.as_ref().unwrap().id.clone(),
                version: before.as_ref().unwrap().version,
                decision_path: None,
            });
        }
        let auto =
            actor.auto_scopes.contains(&input.scope) && (input.id.is_some() || before.is_none());
        let id = if !auto {
            format!("mem_{}", uuid::Uuid::new_v4().simple())
        } else {
            input
                .id
                .clone()
                .unwrap_or_else(|| format!("mem_{}", uuid::Uuid::new_v4().simple()))
        };
        let timestamp = now();
        let version = before.as_ref().map_or(1, |m| m.version + 1);
        let memory = Memory {
            id: id.clone(),
            scope: input.scope,
            client: actor.client.clone(),
            title: input.title,
            body: input.body,
            record: input
                .record
                .or_else(|| before.as_ref().and_then(|m| m.record.clone())),
            kind: input
                .kind
                .or_else(|| before.as_ref().and_then(|m| m.kind.clone())),
            status: if auto { "active" } else { "pending" }.into(),
            tags: input
                .tags
                .unwrap_or_else(|| before.as_ref().map(|m| m.tags.clone()).unwrap_or_default()),
            source_refs: input.source_refs.unwrap_or_else(|| {
                before
                    .as_ref()
                    .map(|m| m.source_refs.clone())
                    .unwrap_or_default()
            }),
            version,
            supersedes: before.as_ref().map(|m| m.id.clone()),
            expires_at: input
                .expires_at
                .or_else(|| before.as_ref().and_then(|m| m.expires_at.clone())),
            created_at: before
                .as_ref()
                .map_or(timestamp.clone(), |m| m.created_at.clone()),
            updated_at: timestamp,
            proposal_id: format!(
                "prop_{}",
                &digest(format!("{}:{}", actor.client, input.request_id).as_bytes())[..32]
            ),
            decision_document: format!(
                "Knowledge/decisions/doc_{}.md",
                &digest(format!("{}:{}", actor.client, input.request_id).as_bytes())[..32]
            ),
            shared: before.as_ref().map_or(share, |m| m.shared),
            restored_from: None,
        };
        // Pending corrections never replace a currently usable memory.
        let result = Outcome {
            status: if auto { "committed" } else { "proposed" }.into(),
            id,
            version,
            decision_path: None,
        };
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        if auto {
            write_record(&tx, &memory)?;
        }
        tx.execute("INSERT INTO changes(id,client,before_data,after_data,created_at) VALUES(?1,?2,?3,?4,?5)",params![memory.id,actor.client,before.as_ref().map(serde_json::to_string).transpose().map_err(|e|e.to_string())?,serde_json::to_string(&memory).map_err(|e|e.to_string())?,now()]).map_err(|e|e.to_string())?;
        tx.execute(
            "INSERT INTO receipts VALUES(?1,?2,?3,?4)",
            params![
                actor.client,
                input.request_id,
                fingerprint,
                serde_json::to_string(&result).map_err(|e| e.to_string())?
            ],
        )
        .map_err(|e| e.to_string())?;
        if auto && memory.shared {
            enqueue(
                &tx,
                &memory,
                before.as_ref().map_or(0, |m| m.version),
                &input.request_id,
            )?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        self.recover()?;
        Ok(result)
    }

    pub fn history(&self, actor: &Actor) -> Result<Value> {
        let mut statement = self.db.prepare("SELECT seq,client,before_data,after_data,created_at FROM changes ORDER BY seq DESC LIMIT 200").map_err(|e|e.to_string())?;
        let rows = statement
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        for row in rows {
            let (seq, client, before, after, at) = row.map_err(|e| e.to_string())?;
            let memory: Memory = serde_json::from_str(&after).map_err(|e| e.to_string())?;
            if actor.permits(&memory.scope) {
                result.push(json!({"seq":seq,"client":client,"before":before.map(|s|serde_json::from_str::<Value>(&s)).transpose().map_err(|e|e.to_string())?,"after":memory,"created_at":at}));
            }
        }
        Ok(json!(result))
    }

    pub fn pending_memory(&self, actor: &Actor, id: &str) -> Result<Memory> {
        let encoded: String = self.db.query_row(
            "SELECT after_data FROM changes WHERE id=?1 AND json_extract(after_data,'$.status')='pending' ORDER BY seq DESC LIMIT 1",
            [id], |r| r.get(0),
        ).map_err(|e| e.to_string())?;
        let memory: Memory = serde_json::from_str(&encoded).map_err(|e| e.to_string())?;
        if !actor.permits(&memory.scope) {
            return Err("Scope is not authorized".into());
        }
        Ok(memory)
    }

    pub fn manage(
        &mut self,
        actor: &Actor,
        id: &str,
        expected: u64,
        action: &str,
    ) -> Result<Memory> {
        let before = self.read(actor, id)?;
        if before.version != expected {
            return Err("Version conflict; reload the memory".into());
        }
        let mut after = before.clone();
        match action {
            "delete" => after.status = "deleted".into(),
            "archive" => after.status = "archived".into(),
            "share" => after.shared = true,
            "unshare" => after.shared = false,
            _ => return Err("Unknown action".into()),
        }
        after.version += 1;
        after.updated_at = now();
        after.client = actor.client.clone();
        self.change(&before, &after, actor)?;
        Ok(after)
    }

    pub fn undo(&mut self, actor: &Actor, seq: i64) -> Result<Memory> {
        let (before, after): (Option<String>, String) = self
            .db
            .query_row(
                "SELECT before_data,after_data FROM changes WHERE seq=?1",
                [seq],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| "Change not found")?;
        let previous: Memory = serde_json::from_str(&after).map_err(|e| e.to_string())?;
        let current = self.get(&previous.id)?.ok_or("Memory not found")?;
        if !actor.permits(&current.scope) || current.version != previous.version {
            return Err("Change is no longer current; review newer changes first".into());
        }
        let mut restored = match before {
            Some(s) => serde_json::from_str::<Memory>(&s).map_err(|e| e.to_string())?,
            None => {
                let mut m = current.clone();
                m.status = "deleted".into();
                m
            }
        };
        restored.version = current.version + 1;
        restored.restored_from = Some(current.version);
        restored.updated_at = now();
        restored.client = actor.client.clone();
        self.change(&current, &restored, actor)?;
        Ok(restored)
    }
    fn change(&mut self, before: &Memory, after: &Memory, actor: &Actor) -> Result<()> {
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        write_record(&tx, after)?;
        tx.execute("INSERT INTO changes(id,client,before_data,after_data,created_at) VALUES(?1,?2,?3,?4,?5)",params![after.id,actor.client,serde_json::to_string(before).map_err(|e|e.to_string())?,serde_json::to_string(after).map_err(|e|e.to_string())?,now()]).map_err(|e|e.to_string())?;
        if before.shared || after.shared {
            let known: Option<u64> = tx
                .query_row(
                    "SELECT CAST(value AS INTEGER) FROM cloud_state WHERE key=?1",
                    [format!("version:{}", after.id)],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            enqueue(
                &tx,
                after,
                known.unwrap_or(if before.shared { before.version } else { 0 }),
                &uuid::Uuid::new_v4().to_string(),
            )?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        self.recover()
    }
    pub fn pending_cloud(&self) -> Result<Vec<Value>> {
        let mut s = self
            .db
            .prepare("SELECT id,base_version,data,request_id,state FROM outbox ORDER BY rowid")
            .map_err(|e| e.to_string())?;
        let rows = s
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, u64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.map(|r|{let(id,base,data,request,state)=r.map_err(|e|e.to_string())?;Ok(json!({"id":id,"expected_version":base,"memory":serde_json::from_str::<Value>(&data).map_err(|e|e.to_string())?,"request_id":request,"state":state}))}).collect()
    }
    pub fn cloud_ack(&mut self, id: &str, request_id: &str, record: &Memory) -> Result<()> {
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO cloud_state VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![format!("version:{id}"),record.version.to_string()]).map_err(|e|e.to_string())?;
        let deleted = tx
            .execute(
                "DELETE FROM outbox WHERE id=?1 AND request_id=?2",
                params![id, request_id],
            )
            .map_err(|e| e.to_string())?;
        if deleted > 0 {
            write_record(&tx, record)?;
        } else {
            // A local edit may have happened while this request was in flight.
            // Keep that edit, but advance its known cloud base to our receipt.
            tx.execute(
                "UPDATE outbox SET base_version=?2 WHERE id=?1 AND state='pending'",
                params![id, record.version],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        self.recover()
    }
    pub fn cloud_conflict(&self, id: &str) -> Result<()> {
        self.db
            .execute("UPDATE outbox SET state='conflict' WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn cloud_pull(&mut self, record: &Memory) -> Result<()> {
        if !valid_id(&record.id) || !record.id.starts_with("mem_") || !valid_id(&record.scope) {
            return Err("Invalid cloud memory".into());
        }
        let pending: bool = self
            .db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM outbox WHERE id=?1)",
                [&record.id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if pending {
            return Ok(());
        }
        if let Some(old) = self.get(&record.id)?
            && (!old.shared || old.version >= record.version)
        {
            return Ok(());
        }
        let before = self.get(&record.id)?;
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO cloud_state VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![format!("version:{}",record.id),record.version.to_string()]).map_err(|e|e.to_string())?;
        write_record(&tx, record)?;
        tx.execute("INSERT INTO changes(id,client,before_data,after_data,created_at) VALUES(?1,'cloud',?2,?3,?4)",params![record.id,before.as_ref().map(serde_json::to_string).transpose().map_err(|e|e.to_string())?,serde_json::to_string(record).map_err(|e|e.to_string())?,now()]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        self.recover()
    }
    pub fn cloud_cursor(&self) -> Result<String> {
        Ok(self
            .db
            .query_row(
                "SELECT value FROM cloud_state WHERE key='cursor'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| "0".into()))
    }
    pub fn rebuild_index(&mut self) -> Result<()> {
        let rows = {
            let mut s = self
                .db
                .prepare("SELECT data FROM memories")
                .map_err(|e| e.to_string())?;
            s.query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM memories_fts", [])
            .map_err(|e| e.to_string())?;
        for data in rows {
            let m: Memory = serde_json::from_str(&data).map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO memories_fts(id,title,body,tags) VALUES(?1,?2,?3,?4)",
                params![m.id, m.title, m.body, m.tags.join(" ")],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn bind_cloud_account(&self, user: &str) -> Result<()> {
        let previous: Option<String> = self
            .db
            .query_row(
                "SELECT value FROM cloud_state WHERE key='account'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if previous.as_deref().is_some_and(|s| s != user) {
            return Err("This vault's shared memories belong to another account. Sign in to that account before syncing.".into());
        }
        self.db
            .execute(
                "INSERT OR IGNORE INTO cloud_state VALUES('account',?1)",
                [user],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn attach_decision(&self, client: &str, request: &str, path: &str) -> Result<()> {
        let encoded: String = self
            .db
            .query_row(
                "SELECT result FROM receipts WHERE client=?1 AND request_id=?2",
                params![client, request],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let mut result: Outcome = serde_json::from_str(&encoded).map_err(|e| e.to_string())?;
        result.decision_path = Some(path.into());
        self.db
            .execute(
                "UPDATE receipts SET result=?3 WHERE client=?1 AND request_id=?2",
                params![
                    client,
                    request,
                    serde_json::to_string(&result).map_err(|e| e.to_string())?
                ],
            )
            .map_err(|e| e.to_string())?;
        self.db.execute("UPDATE changes SET after_data=json_set(after_data,'$.decision_document',?2) WHERE id=?1 AND json_extract(after_data,'$.status')='pending'",params![result.id,path]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn has_remote_proposal(&self, key: &str) -> Result<bool> {
        self.db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM cloud_state WHERE key=?1)",
                [format!("proposal:{key}")],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())
    }
    pub fn check_pending_version(&self, path: &str) -> Result<()> {
        let mut s=self.db.prepare("SELECT after_data FROM changes WHERE json_extract(after_data,'$.decision_document')=?1 AND json_extract(after_data,'$.status')='pending'").map_err(|e|e.to_string())?;
        let rows = s
            .query_map([path], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let proposed: Memory = serde_json::from_str(&row.map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            if let Some(target) = proposed.supersedes {
                let current = self
                    .get(&target)?
                    .ok_or("The memory being corrected no longer exists")?;
                if current.version + 1 != proposed.version || current.status == "deleted" {
                    return Err("Memory changed since this proposal. Read the current memory and create a new proposal.".into());
                }
            }
        }
        Ok(())
    }
    pub fn stage_remote_proposal(&mut self, key: &str, memory: &Memory) -> Result<()> {
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR IGNORE INTO cloud_state VALUES(?1,?2)",
            params![format!("proposal:{key}"), memory.decision_document],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO changes(id,client,before_data,after_data,created_at) VALUES(?1,'cloud-proposal',NULL,?2,?3)",params![memory.id,serde_json::to_string(memory).map_err(|e|e.to_string())?,now()]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn set_cloud_cursor(&self, cursor: &str) -> Result<()> {
        self.db.execute("INSERT INTO cloud_state VALUES('cursor',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[cursor]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn accept_cloud(&mut self, actor: &Actor, id: &str, record: &Memory) -> Result<()> {
        if !actor.permits(&record.scope) || record.id != id {
            return Err("Scope is not authorized".into());
        }
        let before = self.get(id)?;
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM outbox WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO cloud_state VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![format!("version:{}",record.id),record.version.to_string()]).map_err(|e|e.to_string())?;
        write_record(&tx, record)?;
        tx.execute("INSERT INTO changes(id,client,before_data,after_data,created_at) VALUES(?1,'cloud-conflict-resolution',?2,?3,?4)",params![id,before.as_ref().map(serde_json::to_string).transpose().map_err(|e|e.to_string())?,serde_json::to_string(record).map_err(|e|e.to_string())?,now()]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        self.recover()
    }

    fn recover(&mut self) -> Result<()> {
        let dirty = {
            let mut s = self
                .db
                .prepare("SELECT data FROM memories WHERE dirty=1")
                .map_err(|e| e.to_string())?;
            s.query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        for data in dirty {
            let memory: Memory = serde_json::from_str(&data).map_err(|e| e.to_string())?;
            let path = self.root.join(format!("Knowledge/memory/{}.md", memory.id));
            safe_mkdir(&self.root, path.parent().ok_or("Invalid path")?)?;
            ensure_safe(&self.root, &path)?;
            let markdown = markdown(&memory)?;
            atomic_write(&path, markdown.as_bytes())?;
            self.db
                .execute(
                    "UPDATE memories SET dirty=0,checksum=?2 WHERE id=?1",
                    params![memory.id, digest(markdown.as_bytes())],
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    fn reconcile(&mut self) -> Result<()> {
        let directory = self.root.join("Knowledge/memory");
        ensure_safe(&self.root, &directory)?;
        if !directory.exists() {
            return Ok(());
        }
        for entry in fs::read_dir(&directory).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            ensure_safe(&self.root, &path)?;
            if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 2_000_000 {
                continue;
            }
            let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let checksum = digest(text.as_bytes());
            let Some(front) = text.strip_prefix("---\n") else {
                continue;
            };
            let Some((yaml, body)) = front.split_once("\n---\n") else {
                continue;
            };
            let Ok(mut memory) = serde_yaml::from_str::<Memory>(yaml) else {
                continue;
            };
            if serde_yaml::from_str::<Value>(yaml)
                .ok()
                .is_some_and(|v| v["kuku_status"] == "deleted")
            {
                memory.status = "deleted".into();
            }
            memory.body = body.trim().to_string();
            if !valid_id(&memory.id)
                || !memory.id.starts_with("mem_")
                || path.file_stem().and_then(|s| s.to_str()) != Some(memory.id.as_str())
            {
                continue;
            }
            let prior: Option<String> = self
                .db
                .query_row(
                    "SELECT checksum FROM memories WHERE id=?1",
                    [&memory.id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if prior.as_deref() == Some(&checksum) {
                continue;
            }
            if let Some(old) = self.get(&memory.id)? {
                if old.status == "deleted" {
                    self.db
                        .execute("UPDATE memories SET dirty=1 WHERE id=?1", [&old.id])
                        .map_err(|e| e.to_string())?;
                    continue;
                }
                // A hand-edited body is authoritative; never retain a stale structured view.
                if memory
                    .record
                    .as_ref()
                    .is_some_and(|r| r.validate().is_err() || memory.body.trim() != r.body().trim())
                {
                    memory.record = None;
                }
                // File edits cannot broaden sharing or move a memory to another scope.
                memory.scope = old.scope.clone();
                memory.shared = old.shared;
                memory.version = old.version + 1;
                memory.updated_at = now();
                memory.client = "kuku-editor".into();
                let actor = Actor {
                    client: "kuku-editor".into(),
                    scopes: vec![old.scope.clone()],
                    auto_scopes: vec![],
                };
                self.change(&old, &memory, &actor)?;
            } else {
                let pending:Option<String>=self.db.query_row("SELECT after_data FROM changes WHERE id=?1 AND json_extract(after_data,'$.status')='pending' ORDER BY seq DESC LIMIT 1",[&memory.id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
                let managed = pending.is_some();
                if let Some(pending) = pending {
                    let proposed: Memory =
                        serde_json::from_str(&pending).map_err(|e| e.to_string())?;
                    memory.scope = proposed.scope;
                    memory.client = proposed.client;
                    memory.shared = proposed.shared;
                    memory.supersedes = proposed.supersedes;
                    memory.source_refs = proposed.source_refs;
                    memory.expires_at = proposed.expires_at;
                    memory.record = proposed
                        .record
                        .filter(|r| memory.body.trim() == r.body().trim());
                    memory.version = 1;
                    if let Some(old_id) = &memory.supersedes
                        && let Some(old) = self.get(old_id)?
                    {
                        let mut superseded = old.clone();
                        superseded.status = "superseded".into();
                        superseded.version += 1;
                        superseded.updated_at = now();
                        let actor = Actor {
                            client: "kuku-review".into(),
                            scopes: vec![old.scope.clone()],
                            auto_scopes: vec![],
                        };
                        self.change(&old, &superseded, &actor)?;
                    }
                    if memory.shared {
                        enqueue(&self.db, &memory, 0, &uuid::Uuid::new_v4().to_string())?;
                    }
                } else {
                    memory.shared = false;
                    if !valid_id(&memory.scope) {
                        continue;
                    }
                }
                write_record(&self.db, &memory)?;
                if !managed {
                    self.db
                        .execute(
                            "UPDATE memories SET dirty=0,checksum=?2 WHERE id=?1",
                            params![memory.id, checksum],
                        )
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        let records = {
            let mut s=self.db.prepare("SELECT data FROM memories WHERE json_extract(data,'$.status')!='deleted' AND checksum!=''").map_err(|e|e.to_string())?;
            s.query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        for data in records {
            let old: Memory = serde_json::from_str(&data).map_err(|e| e.to_string())?;
            let path = self.root.join(format!("Knowledge/memory/{}.md", old.id));
            if !path.exists() {
                let mut deleted = old.clone();
                deleted.status = "deleted".into();
                deleted.version += 1;
                deleted.updated_at = now();
                let actor = Actor {
                    client: "kuku-editor".into(),
                    scopes: vec![old.scope.clone()],
                    auto_scopes: vec![],
                };
                self.change(&old, &deleted, &actor)?;
            }
        }
        self.recover()
    }
}

fn write_record(db: &Connection, memory: &Memory) -> Result<()> {
    let data = serde_json::to_string(memory).map_err(|e| e.to_string())?;
    db.execute("INSERT INTO memories(id,scope,data,dirty) VALUES(?1,?2,?3,1) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,data=excluded.data,dirty=1",params![memory.id,memory.scope,data]).map_err(|e|e.to_string())?;
    db.execute("DELETE FROM memories_fts WHERE id=?1", [&memory.id])
        .map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO memories_fts(id,title,body,tags) VALUES(?1,?2,?3,?4)",
        params![memory.id, memory.title, memory.body, memory.tags.join(" ")],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
fn enqueue(db: &Connection, m: &Memory, base: u64, request: &str) -> Result<()> {
    db.execute("INSERT INTO outbox(id,base_version,data,request_id) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET data=excluded.data,request_id=excluded.request_id,state='pending'",params![m.id,base,serde_json::to_string(m).map_err(|e|e.to_string())?,request]).map_err(|e|e.to_string())?;
    Ok(())
}
pub fn markdown(m: &Memory) -> Result<String> {
    let mut v = serde_json::to_value(m).map_err(|e| e.to_string())?;
    v.as_object_mut().ok_or("Invalid memory")?.remove("body");
    for key in ["created_at", "updated_at"] {
        let timestamp = v[key].as_str().ok_or("Invalid timestamp")?;
        let canonical = DateTime::parse_from_rfc3339(timestamp)
            .map_err(|_| "Invalid timestamp")?
            .with_timezone(&Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        v[key] = json!(canonical);
    }
    if m.status == "deleted" {
        v["status"] = json!("archived");
        v["kuku_status"] = json!("deleted");
    }
    if let Some(sources) = v["source_refs"].as_array_mut() {
        for source in sources {
            if source["title"]
                .as_str()
                .is_some_and(|s| s.trim().is_empty())
            {
                source["title"] = Value::Null;
            }
            let timestamp = source["captured_at"]
                .as_str()
                .ok_or("Invalid source timestamp")?;
            source["captured_at"] = json!(
                DateTime::parse_from_rfc3339(timestamp)
                    .map_err(|_| "Invalid source timestamp")?
                    .with_timezone(&Utc)
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
            );
            if let Some(path) = source["path"].as_str().map(str::to_string)
                && (path.starts_with('/')
                    || path.starts_with('\\')
                    || path.contains("://")
                    || (path.as_bytes().get(1) == Some(&b':')
                        && path.as_bytes()[0].is_ascii_alphabetic())
                    || path.contains('%')
                    || path.chars().any(char::is_control)
                    || path
                        .split(['/', '\\'])
                        .any(|s| s.is_empty() || s == ".." || s == "."))
            {
                source["origin"] = json!(path);
                source["path"] = json!(format!(
                    "Knowledge/sources/ai_{}.md",
                    &digest(path.as_bytes())[..24]
                ));
            }
        }
    }
    let yaml = serde_yaml::to_string(&v).map_err(|e| e.to_string())?;
    Ok(format!(
        "---\n{}---\n{}\n",
        yaml.trim_start_matches("---\n"),
        m.body
    ))
}
pub fn ensure_safe(root: &Path, path: &Path) -> Result<()> {
    let relative = path.strip_prefix(root).map_err(|_| "Path escapes vault")?;
    let mut current = root.to_path_buf();
    for part in relative.components() {
        if !matches!(part, std::path::Component::Normal(_)) {
            return Err("Invalid vault path".into());
        }
        current.push(part);
        if fs::symlink_metadata(&current).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("Symlinks are not allowed in memory paths".into());
        }
    }
    Ok(())
}
fn safe_mkdir(root: &Path, path: &Path) -> Result<()> {
    ensure_safe(root, path)?;
    fs::create_dir_all(path).map_err(|e| e.to_string())
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    fs::rename(&temporary, path).map_err(|e| e.to_string())?;
    fs::File::open(path.parent().ok_or("Invalid file path")?)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())
}

pub fn brief(memories: Vec<Memory>) -> Value {
    json!(memories.into_iter().map(|m|json!({"id":m.id,"scope":m.scope,"title":m.title,"summary":m.body.chars().take(240).collect::<String>(),"kind":m.kind,"version":m.version,"source_refs":m.source_refs.iter().take(3).map(|s|json!({"path":s.path.chars().take(240).collect::<String>(),"title":s.title,"captured_at":s.captured_at})).collect::<Vec<_>>(),"updated_at":m.updated_at})).collect::<Vec<_>>())
}

#[cfg(test)]
mod tests;
