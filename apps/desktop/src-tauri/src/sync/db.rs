#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::variant;

use super::errors::{SyncError, SyncResult};

const CURRENT_SCHEMA_VERSION: i64 = 1;
const SCHEMA_VERSION_KEY: &str = "schema_version";

pub const FILE_KIND_MARKDOWN: &str = "markdown";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncVaultRecord {
    pub vault_id: String,
    pub root_path: String,
    pub remote_workspace_id: String,
    pub remote_head_commit_id: Option<String>,
    pub local_head_commit_id: Option<String>,
    pub device_id: String,
    pub next_device_seq: i64,
    pub enabled: bool,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncFileInput {
    pub path: String,
    pub normalized_path: String,
    pub kind: String,
    pub plaintext_hash: Option<String>,
    pub size_bytes: Option<i64>,
    pub mtime_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncFileRecord {
    pub file_id: String,
    pub path: String,
    pub normalized_path: String,
    pub kind: String,
    pub plaintext_hash: Option<String>,
    pub size_bytes: Option<i64>,
    pub mtime_ms: Option<i64>,
    pub last_synced_commit_id: Option<String>,
    pub dirty: bool,
    pub deleted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanApplyResult {
    pub upserts: Vec<SyncFileRecord>,
    pub deletions: Vec<SyncFileRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncTreeEntryRecord {
    pub commit_id: String,
    pub file_id: String,
    pub normalized_path: String,
    pub plaintext_hash: Option<String>,
    pub content_object_id: Option<String>,
    pub pack_entry_id: Option<String>,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncCommitRecord {
    pub commit_id: String,
    pub parent_commit_ids_json: String,
    pub commit_kind: String,
    pub direction: String,
    pub status: String,
    pub created_at_ms: i64,
    pub applied_at_ms: Option<i64>,
    pub error: Option<String>,
}

pub fn sync_db_path(home: &Path, vault_id: &str) -> SyncResult<PathBuf> {
    validate_vault_id(vault_id)?;
    Ok(variant::data_root(home)
        .join("sync")
        .join(format!("{vault_id}.sqlite")))
}

pub fn open_sync_db(path: &Path) -> SyncResult<Connection> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(path).map_err(|error| SyncError::Storage(error.to_string()))?;
    configure_connection(&conn)?;
    init_schema(&conn)?;
    Ok(conn)
}

pub fn open_memory_sync_db() -> SyncResult<Connection> {
    let conn =
        Connection::open_in_memory().map_err(|error| SyncError::Storage(error.to_string()))?;
    configure_connection(&conn)?;
    init_schema(&conn)?;
    Ok(conn)
}

pub fn configure_connection(conn: &Connection) -> SyncResult<()> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        "#,
    )
    .map_err(|error| SyncError::Storage(format!("failed to configure sync DB: {error}")))
}

pub fn init_schema(conn: &Connection) -> SyncResult<()> {
    conn.execute_batch(CREATE_SCHEMA_SQL)
        .map_err(|error| SyncError::Storage(format!("failed to initialize sync DB: {error}")))?;
    let stored = metadata_value(conn, SCHEMA_VERSION_KEY)?;
    match stored.as_deref() {
        Some(value) if value == CURRENT_SCHEMA_VERSION.to_string() => Ok(()),
        Some(_) => {
            reset_schema(conn)?;
            conn.execute_batch(CREATE_SCHEMA_SQL).map_err(|error| {
                SyncError::Storage(format!("failed to recreate sync DB schema: {error}"))
            })?;
            persist_schema_version(conn)
        }
        None => persist_schema_version(conn),
    }
}

pub fn upsert_vault(conn: &Connection, vault: &SyncVaultRecord) -> SyncResult<()> {
    conn.execute(
        r#"
        INSERT INTO sync_vaults (
            vault_id, root_path, remote_workspace_id, remote_head_commit_id,
            local_head_commit_id, device_id, next_device_seq, enabled,
            created_at_ms, updated_at_ms
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(vault_id) DO UPDATE SET
            root_path = excluded.root_path,
            remote_workspace_id = excluded.remote_workspace_id,
            remote_head_commit_id = excluded.remote_head_commit_id,
            local_head_commit_id = excluded.local_head_commit_id,
            device_id = excluded.device_id,
            next_device_seq = excluded.next_device_seq,
            enabled = excluded.enabled,
            updated_at_ms = excluded.updated_at_ms
        "#,
        params![
            vault.vault_id,
            vault.root_path,
            vault.remote_workspace_id,
            vault.remote_head_commit_id,
            vault.local_head_commit_id,
            vault.device_id,
            vault.next_device_seq,
            bool_to_i64(vault.enabled),
            vault.created_at_ms,
            vault.updated_at_ms,
        ],
    )
    .map_err(|error| SyncError::Storage(format!("failed to upsert sync vault: {error}")))?;
    Ok(())
}

pub fn get_vault(conn: &Connection, vault_id: &str) -> SyncResult<Option<SyncVaultRecord>> {
    conn.query_row(
        r#"
        SELECT vault_id, root_path, remote_workspace_id, remote_head_commit_id,
               local_head_commit_id, device_id, next_device_seq, enabled,
               created_at_ms, updated_at_ms
        FROM sync_vaults
        WHERE vault_id = ?1
        "#,
        params![vault_id],
        |row| {
            Ok(SyncVaultRecord {
                vault_id: row.get(0)?,
                root_path: row.get(1)?,
                remote_workspace_id: row.get(2)?,
                remote_head_commit_id: row.get(3)?,
                local_head_commit_id: row.get(4)?,
                device_id: row.get(5)?,
                next_device_seq: row.get(6)?,
                enabled: i64_to_bool(row.get(7)?),
                created_at_ms: row.get(8)?,
                updated_at_ms: row.get(9)?,
            })
        },
    )
    .optional()
    .map_err(|error| SyncError::Storage(format!("failed to read sync vault: {error}")))
}

pub fn apply_scan(
    conn: &mut Connection,
    files: &[SyncFileInput],
    now_ms: i64,
) -> SyncResult<ScanApplyResult> {
    let tx = conn.transaction().map_err(|error| {
        SyncError::Storage(format!("failed to start scan transaction: {error}"))
    })?;
    let existing = list_files_tx(&tx)?;
    let mut seen_normalized = Vec::with_capacity(files.len());
    let mut upserts = Vec::new();

    for file in files {
        validate_file_input(file)?;
        if seen_normalized
            .iter()
            .any(|value: &String| value == &file.normalized_path)
        {
            return Err(SyncError::InvalidArgument(format!(
                "duplicate normalized sync path: {}",
                file.normalized_path
            )));
        }
        seen_normalized.push(file.normalized_path.clone());
        let previous = existing
            .iter()
            .find(|row| row.normalized_path == file.normalized_path);
        let file_id = previous
            .map(|row| row.file_id.clone())
            .unwrap_or_else(|| file_id_for_normalized_path(&file.normalized_path));
        let dirty = previous.is_none_or(|row| {
            row.deleted
                || row.path != file.path
                || row.kind != file.kind
                || row.plaintext_hash != file.plaintext_hash
                || row.size_bytes != file.size_bytes
        });
        tx.execute(
            r#"
            INSERT INTO sync_files (
                file_id, path, normalized_path, kind, plaintext_hash,
                size_bytes, mtime_ms, dirty, deleted
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)
            ON CONFLICT(normalized_path) DO UPDATE SET
                path = excluded.path,
                kind = excluded.kind,
                plaintext_hash = excluded.plaintext_hash,
                size_bytes = excluded.size_bytes,
                mtime_ms = excluded.mtime_ms,
                dirty = CASE WHEN sync_files.dirty = 1 OR ?9 = 1 THEN 1 ELSE 0 END,
                deleted = 0
            "#,
            params![
                file_id,
                file.path,
                file.normalized_path,
                file.kind,
                file.plaintext_hash,
                file.size_bytes,
                file.mtime_ms,
                bool_to_i64(dirty),
                bool_to_i64(dirty),
            ],
        )
        .map_err(|error| SyncError::Storage(format!("failed to upsert sync file: {error}")))?;
        upserts.push(get_file_by_normalized_tx(&tx, &file.normalized_path)?);
    }

    let mut deletions = Vec::new();
    for row in existing {
        if row.deleted || seen_normalized.contains(&row.normalized_path) {
            continue;
        }
        tx.execute(
            r#"
            UPDATE sync_files
            SET deleted = 1,
                dirty = 1,
                mtime_ms = ?2
            WHERE file_id = ?1
            "#,
            params![row.file_id, now_ms],
        )
        .map_err(|error| {
            SyncError::Storage(format!("failed to mark deleted sync file: {error}"))
        })?;
        deletions.push(get_file_by_id_tx(&tx, &row.file_id)?);
    }

    tx.commit().map_err(|error| {
        SyncError::Storage(format!("failed to commit scan transaction: {error}"))
    })?;
    Ok(ScanApplyResult { upserts, deletions })
}

pub fn list_files(conn: &Connection) -> SyncResult<Vec<SyncFileRecord>> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT file_id, path, normalized_path, kind, plaintext_hash, size_bytes,
                   mtime_ms, last_synced_commit_id, dirty, deleted
            FROM sync_files
            ORDER BY normalized_path
            "#,
        )
        .map_err(|error| SyncError::Storage(format!("failed to prepare file list: {error}")))?;
    let rows = stmt
        .query_map([], sync_file_from_row)
        .map_err(|error| SyncError::Storage(format!("failed to query sync files: {error}")))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| SyncError::Storage(format!("failed to read sync files: {error}")))
}

pub fn list_dirty_files(conn: &Connection) -> SyncResult<Vec<SyncFileRecord>> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT file_id, path, normalized_path, kind, plaintext_hash, size_bytes,
                   mtime_ms, last_synced_commit_id, dirty, deleted
            FROM sync_files
            WHERE dirty = 1
            ORDER BY normalized_path
            "#,
        )
        .map_err(|error| {
            SyncError::Storage(format!("failed to prepare dirty file list: {error}"))
        })?;
    let rows = stmt
        .query_map([], sync_file_from_row)
        .map_err(|error| SyncError::Storage(format!("failed to query dirty files: {error}")))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| SyncError::Storage(format!("failed to read dirty files: {error}")))
}

pub fn persist_tree_cache(
    conn: &mut Connection,
    commit_id: &str,
    tree_id: &str,
    tree_json: &str,
    source: &str,
    entries: &[SyncTreeEntryRecord],
    created_at_ms: i64,
) -> SyncResult<()> {
    let tx = conn.transaction().map_err(|error| {
        SyncError::Storage(format!("failed to start tree cache transaction: {error}"))
    })?;
    tx.execute(
        r#"
        INSERT INTO sync_commit_trees (commit_id, tree_id, tree_json, source, created_at_ms)
        VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(commit_id) DO UPDATE SET
            tree_id = excluded.tree_id,
            tree_json = excluded.tree_json,
            source = excluded.source,
            created_at_ms = excluded.created_at_ms
        "#,
        params![commit_id, tree_id, tree_json, source, created_at_ms],
    )
    .map_err(|error| SyncError::Storage(format!("failed to persist tree cache: {error}")))?;
    tx.execute(
        "DELETE FROM sync_tree_entries WHERE commit_id = ?1",
        params![commit_id],
    )
    .map_err(|error| SyncError::Storage(format!("failed to clear tree entries: {error}")))?;
    for entry in entries {
        tx.execute(
            r#"
            INSERT INTO sync_tree_entries (
                commit_id, file_id, normalized_path, plaintext_hash,
                content_object_id, pack_entry_id, kind
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            "#,
            params![
                entry.commit_id,
                entry.file_id,
                entry.normalized_path,
                entry.plaintext_hash,
                entry.content_object_id,
                entry.pack_entry_id,
                entry.kind,
            ],
        )
        .map_err(|error| SyncError::Storage(format!("failed to persist tree entry: {error}")))?;
    }
    tx.commit().map_err(|error| {
        SyncError::Storage(format!("failed to commit tree cache transaction: {error}"))
    })
}

pub fn list_tree_entries(
    conn: &Connection,
    commit_id: &str,
) -> SyncResult<Vec<SyncTreeEntryRecord>> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT commit_id, file_id, normalized_path, plaintext_hash,
                   content_object_id, pack_entry_id, kind
            FROM sync_tree_entries
            WHERE commit_id = ?1
            ORDER BY normalized_path
            "#,
        )
        .map_err(|error| SyncError::Storage(format!("failed to prepare tree entries: {error}")))?;
    let rows = stmt
        .query_map(params![commit_id], sync_tree_entry_from_row)
        .map_err(|error| SyncError::Storage(format!("failed to query tree entries: {error}")))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| SyncError::Storage(format!("failed to read tree entries: {error}")))
}

pub fn upsert_local_commit(conn: &Connection, commit: &SyncCommitRecord) -> SyncResult<()> {
    conn.execute(
        r#"
        INSERT INTO sync_commits (
            commit_id, parent_commit_ids_json, commit_kind, direction, status,
            created_at_ms, applied_at_ms, error
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(commit_id) DO UPDATE SET
            parent_commit_ids_json = excluded.parent_commit_ids_json,
            commit_kind = excluded.commit_kind,
            direction = excluded.direction,
            status = excluded.status,
            applied_at_ms = excluded.applied_at_ms,
            error = excluded.error
        "#,
        params![
            commit.commit_id,
            commit.parent_commit_ids_json,
            commit.commit_kind,
            commit.direction,
            commit.status,
            commit.created_at_ms,
            commit.applied_at_ms,
            commit.error,
        ],
    )
    .map_err(|error| SyncError::Storage(format!("failed to upsert sync commit: {error}")))?;
    Ok(())
}

pub fn update_vault_after_publish(
    conn: &Connection,
    vault_id: &str,
    commit_id: &str,
    next_device_seq: i64,
    updated_at_ms: i64,
) -> SyncResult<()> {
    conn.execute(
        r#"
        UPDATE sync_vaults
        SET remote_head_commit_id = ?2,
            local_head_commit_id = ?2,
            next_device_seq = ?3,
            updated_at_ms = ?4
        WHERE vault_id = ?1
        "#,
        params![vault_id, commit_id, next_device_seq, updated_at_ms],
    )
    .map_err(|error| SyncError::Storage(format!("failed to update sync vault head: {error}")))?;
    Ok(())
}

pub fn mark_files_synced(
    conn: &mut Connection,
    commit_id: &str,
    file_ids: &[String],
) -> SyncResult<()> {
    let tx = conn.transaction().map_err(|error| {
        SyncError::Storage(format!("failed to start synced file transaction: {error}"))
    })?;
    for file_id in file_ids {
        tx.execute(
            r#"
            UPDATE sync_files
            SET dirty = 0,
                last_synced_commit_id = ?2
            WHERE file_id = ?1
            "#,
            params![file_id, commit_id],
        )
        .map_err(|error| SyncError::Storage(format!("failed to mark sync file clean: {error}")))?;
    }
    tx.commit().map_err(|error| {
        SyncError::Storage(format!("failed to commit synced file transaction: {error}"))
    })
}

pub fn file_id_for_normalized_path(normalized_path: &str) -> String {
    let hash = blake3::hash(normalized_path.as_bytes())
        .to_hex()
        .to_string();
    format!("file_{}", &hash[..32])
}

fn validate_vault_id(vault_id: &str) -> SyncResult<()> {
    if vault_id.is_empty()
        || !vault_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err(SyncError::InvalidArgument("invalid vault_id".into()));
    }
    Ok(())
}

fn validate_file_input(file: &SyncFileInput) -> SyncResult<()> {
    if file.path.trim().is_empty() || file.normalized_path.trim().is_empty() {
        return Err(SyncError::InvalidArgument(
            "sync file path is required".into(),
        ));
    }
    if file.kind.trim().is_empty() {
        return Err(SyncError::InvalidArgument(
            "sync file kind is required".into(),
        ));
    }
    Ok(())
}

fn metadata_value(conn: &Connection, key: &str) -> SyncResult<Option<String>> {
    conn.query_row(
        "SELECT value FROM sync_metadata WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| SyncError::Storage(format!("failed to read sync metadata: {error}")))
}

fn persist_schema_version(conn: &Connection) -> SyncResult<()> {
    conn.execute(
        r#"
        INSERT INTO sync_metadata(key, value)
        VALUES (?1, ?2)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        "#,
        params![SCHEMA_VERSION_KEY, CURRENT_SCHEMA_VERSION.to_string()],
    )
    .map_err(|error| SyncError::Storage(format!("failed to persist schema version: {error}")))?;
    Ok(())
}

fn reset_schema(conn: &Connection) -> SyncResult<()> {
    conn.execute_batch(
        r#"
        DROP TABLE IF EXISTS sync_conflicts;
        DROP TABLE IF EXISTS sync_tree_entries;
        DROP TABLE IF EXISTS sync_commit_trees;
        DROP TABLE IF EXISTS sync_commits;
        DROP TABLE IF EXISTS sync_transfers;
        DROP TABLE IF EXISTS sync_checkpoint_objects;
        DROP TABLE IF EXISTS sync_checkpoints;
        DROP TABLE IF EXISTS sync_packs;
        DROP TABLE IF EXISTS sync_objects;
        DROP TABLE IF EXISTS sync_files;
        DROP TABLE IF EXISTS sync_vaults;
        DROP TABLE IF EXISTS sync_metadata;
        "#,
    )
    .map_err(|error| SyncError::Storage(format!("failed to reset sync DB schema: {error}")))
}

fn list_files_tx(tx: &Transaction<'_>) -> SyncResult<Vec<SyncFileRecord>> {
    let mut stmt = tx
        .prepare(
            r#"
            SELECT file_id, path, normalized_path, kind, plaintext_hash, size_bytes,
                   mtime_ms, last_synced_commit_id, dirty, deleted
            FROM sync_files
            ORDER BY normalized_path
            "#,
        )
        .map_err(|error| {
            SyncError::Storage(format!("failed to prepare sync file list: {error}"))
        })?;
    let rows = stmt
        .query_map([], sync_file_from_row)
        .map_err(|error| SyncError::Storage(format!("failed to query sync files: {error}")))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| SyncError::Storage(format!("failed to read sync file rows: {error}")))
}

fn get_file_by_normalized_tx(
    tx: &Transaction<'_>,
    normalized_path: &str,
) -> SyncResult<SyncFileRecord> {
    tx.query_row(
        r#"
        SELECT file_id, path, normalized_path, kind, plaintext_hash, size_bytes,
               mtime_ms, last_synced_commit_id, dirty, deleted
        FROM sync_files
        WHERE normalized_path = ?1
        "#,
        params![normalized_path],
        sync_file_from_row,
    )
    .map_err(|error| SyncError::Storage(format!("failed to read sync file: {error}")))
}

fn get_file_by_id_tx(tx: &Transaction<'_>, file_id: &str) -> SyncResult<SyncFileRecord> {
    tx.query_row(
        r#"
        SELECT file_id, path, normalized_path, kind, plaintext_hash, size_bytes,
               mtime_ms, last_synced_commit_id, dirty, deleted
        FROM sync_files
        WHERE file_id = ?1
        "#,
        params![file_id],
        sync_file_from_row,
    )
    .map_err(|error| SyncError::Storage(format!("failed to read sync file: {error}")))
}

fn sync_file_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SyncFileRecord> {
    Ok(SyncFileRecord {
        file_id: row.get(0)?,
        path: row.get(1)?,
        normalized_path: row.get(2)?,
        kind: row.get(3)?,
        plaintext_hash: row.get(4)?,
        size_bytes: row.get(5)?,
        mtime_ms: row.get(6)?,
        last_synced_commit_id: row.get(7)?,
        dirty: i64_to_bool(row.get(8)?),
        deleted: i64_to_bool(row.get(9)?),
    })
}

fn sync_tree_entry_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SyncTreeEntryRecord> {
    Ok(SyncTreeEntryRecord {
        commit_id: row.get(0)?,
        file_id: row.get(1)?,
        normalized_path: row.get(2)?,
        plaintext_hash: row.get(3)?,
        content_object_id: row.get(4)?,
        pack_entry_id: row.get(5)?,
        kind: row.get(6)?,
    })
}

fn bool_to_i64(value: bool) -> i64 {
    if value { 1 } else { 0 }
}

fn i64_to_bool(value: i64) -> bool {
    value != 0
}

const CREATE_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS sync_metadata (
  key text primary key,
  value text not null
);

CREATE TABLE IF NOT EXISTS sync_vaults (
  vault_id text primary key,
  root_path text not null,
  remote_workspace_id text not null,
  remote_head_commit_id text null,
  local_head_commit_id text null,
  device_id text not null,
  next_device_seq integer not null,
  enabled integer not null,
  created_at_ms integer not null,
  updated_at_ms integer not null
);

CREATE TABLE IF NOT EXISTS sync_files (
  file_id text primary key,
  path text not null,
  normalized_path text not null,
  kind text not null,
  plaintext_hash text null,
  size_bytes integer null,
  mtime_ms integer null,
  last_synced_commit_id text null,
  dirty integer not null default 0,
  deleted integer not null default 0,
  unique(normalized_path)
);

CREATE INDEX IF NOT EXISTS idx_sync_files_dirty ON sync_files(dirty, deleted);

CREATE TABLE IF NOT EXISTS sync_objects (
  object_id text primary key,
  object_kind text not null,
  ciphertext_sha256 text not null,
  size_bytes integer not null,
  status text not null,
  created_at_ms integer not null
);

CREATE TABLE IF NOT EXISTS sync_packs (
  object_id text primary key,
  pack_kind text not null,
  entry_count integer not null,
  compressed_size_bytes integer not null,
  encrypted_size_bytes integer not null
);

CREATE TABLE IF NOT EXISTS sync_checkpoints (
  checkpoint_commit_id text primary key,
  base_head_commit_id text null,
  tree_id text not null,
  created_at_ms integer not null
);

CREATE TABLE IF NOT EXISTS sync_checkpoint_objects (
  checkpoint_commit_id text not null,
  object_id text not null,
  shard_index integer not null,
  primary key (checkpoint_commit_id, object_id)
);

CREATE TABLE IF NOT EXISTS sync_transfers (
  transfer_id text primary key,
  object_id text not null,
  direction text not null,
  status text not null,
  attempt_count integer not null,
  last_error text null,
  updated_at_ms integer not null
);

CREATE TABLE IF NOT EXISTS sync_commits (
  commit_id text primary key,
  parent_commit_ids_json text not null,
  commit_kind text not null,
  direction text not null,
  status text not null,
  created_at_ms integer not null,
  applied_at_ms integer null,
  error text null
);

CREATE TABLE IF NOT EXISTS sync_commit_trees (
  commit_id text primary key,
  tree_id text not null,
  tree_json text not null,
  source text not null,
  created_at_ms integer not null
);

CREATE TABLE IF NOT EXISTS sync_tree_entries (
  commit_id text not null,
  file_id text not null,
  normalized_path text not null,
  plaintext_hash text null,
  content_object_id text null,
  pack_entry_id text null,
  kind text not null,
  primary key (commit_id, file_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_tree_entries_path ON sync_tree_entries(normalized_path);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  conflict_id text primary key,
  path text not null,
  conflict_path text not null,
  base_commit_id text null,
  local_commit_id text null,
  remote_commit_id text null,
  status text not null,
  created_at_ms integer not null
);
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_db_path_uses_variant_sync_directory() {
        let path = sync_db_path(Path::new("/home/me"), "vault_1").unwrap();

        assert!(path.ends_with(".kuku/sync/vault_1.sqlite"));
    }

    #[test]
    fn init_schema_creates_required_tables_and_version() {
        let conn = open_memory_sync_db().unwrap();

        for table in [
            "sync_vaults",
            "sync_files",
            "sync_objects",
            "sync_packs",
            "sync_commits",
            "sync_commit_trees",
            "sync_tree_entries",
            "sync_checkpoints",
            "sync_checkpoint_objects",
        ] {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    params![table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1, "missing table {table}");
        }
        assert_eq!(
            metadata_value(&conn, SCHEMA_VERSION_KEY)
                .unwrap()
                .as_deref(),
            Some("1")
        );
    }

    #[test]
    fn upsert_vault_roundtrips_and_updates() {
        let conn = open_memory_sync_db().unwrap();
        let mut vault = SyncVaultRecord {
            vault_id: "vault_1".into(),
            root_path: "/tmp/vault".into(),
            remote_workspace_id: "workspace_1".into(),
            remote_head_commit_id: None,
            local_head_commit_id: None,
            device_id: "device_1".into(),
            next_device_seq: 1,
            enabled: true,
            created_at_ms: 1,
            updated_at_ms: 1,
        };

        upsert_vault(&conn, &vault).unwrap();
        vault.remote_head_commit_id = Some("commit-1".into());
        vault.local_head_commit_id = Some("commit-1".into());
        vault.next_device_seq = 2;
        vault.enabled = false;
        vault.updated_at_ms = 2;
        upsert_vault(&conn, &vault).unwrap();

        let stored = get_vault(&conn, "vault_1").unwrap().unwrap();
        assert_eq!(stored.remote_head_commit_id.as_deref(), Some("commit-1"));
        assert_eq!(stored.next_device_seq, 2);
        assert!(!stored.enabled);
        assert_eq!(stored.created_at_ms, 1);
        assert_eq!(stored.updated_at_ms, 2);
    }

    #[test]
    fn apply_scan_rejects_duplicate_normalized_paths() {
        let mut conn = open_memory_sync_db().unwrap();
        let err = apply_scan(
            &mut conn,
            &[
                SyncFileInput {
                    path: "A.md".into(),
                    normalized_path: "a.md".into(),
                    kind: FILE_KIND_MARKDOWN.into(),
                    plaintext_hash: Some("hash-1".into()),
                    size_bytes: Some(1),
                    mtime_ms: Some(1),
                },
                SyncFileInput {
                    path: "a.md".into(),
                    normalized_path: "a.md".into(),
                    kind: FILE_KIND_MARKDOWN.into(),
                    plaintext_hash: Some("hash-2".into()),
                    size_bytes: Some(2),
                    mtime_ms: Some(1),
                },
            ],
            1,
        )
        .unwrap_err();

        assert!(
            matches!(err, SyncError::InvalidArgument(message) if message.contains("duplicate normalized"))
        );
    }

    #[test]
    fn apply_scan_preserves_file_id_for_case_only_rename_and_marks_dirty() {
        let mut conn = open_memory_sync_db().unwrap();
        let first = SyncFileInput {
            path: "Notes/Plan.md".into(),
            normalized_path: "notes/plan.md".into(),
            kind: FILE_KIND_MARKDOWN.into(),
            plaintext_hash: Some("hash-1".into()),
            size_bytes: Some(10),
            mtime_ms: Some(1),
        };
        let first_result = apply_scan(&mut conn, &[first], 1).unwrap();
        let file_id = first_result.upserts[0].file_id.clone();
        mark_files_synced(&mut conn, "commit-1", std::slice::from_ref(&file_id)).unwrap();

        let second = SyncFileInput {
            path: "notes/plan.md".into(),
            normalized_path: "notes/plan.md".into(),
            kind: FILE_KIND_MARKDOWN.into(),
            plaintext_hash: Some("hash-1".into()),
            size_bytes: Some(10),
            mtime_ms: Some(2),
        };
        let second_result = apply_scan(&mut conn, &[second], 2).unwrap();

        assert_eq!(second_result.upserts[0].file_id, file_id);
        assert!(second_result.upserts[0].dirty);
        assert_eq!(second_result.upserts[0].path, "notes/plan.md");
    }

    #[test]
    fn apply_scan_marks_missing_files_deleted() {
        let mut conn = open_memory_sync_db().unwrap();
        let input = SyncFileInput {
            path: "a.md".into(),
            normalized_path: "a.md".into(),
            kind: FILE_KIND_MARKDOWN.into(),
            plaintext_hash: Some("hash".into()),
            size_bytes: Some(1),
            mtime_ms: Some(1),
        };
        apply_scan(&mut conn, &[input], 1).unwrap();

        let result = apply_scan(&mut conn, &[], 2).unwrap();

        assert_eq!(result.deletions.len(), 1);
        assert!(result.deletions[0].deleted);
        assert!(result.deletions[0].dirty);
    }

    #[test]
    fn persist_tree_cache_roundtrips_entries() {
        let mut conn = open_memory_sync_db().unwrap();
        let entry = SyncTreeEntryRecord {
            commit_id: "commit-1".into(),
            file_id: "file-1".into(),
            normalized_path: "a.md".into(),
            plaintext_hash: Some("hash".into()),
            content_object_id: Some("object-1".into()),
            pack_entry_id: Some("entry-1".into()),
            kind: FILE_KIND_MARKDOWN.into(),
        };

        persist_tree_cache(
            &mut conn,
            "commit-1",
            "tree-1",
            "{\"entries\":[]}",
            "local",
            &[entry],
            10,
        )
        .unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_tree_entries", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
    }
}
