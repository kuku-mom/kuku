use std::path::Path;

use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::models::SimpleSearchHit;
use crate::search::wikilink::{
    DocIdentity, LinkResolution, RESOLUTION_UNRESOLVED, to_doc_identity,
};

const CURRENT_INDEX_VERSION: i64 = 1;
const INDEX_VERSION_KEY: &str = "index_version";

#[derive(Debug, Clone)]
pub struct IndexedChunkRow {
    pub section_path_json: String,
    pub kind: String,
    pub text: String,
    pub raw_text: String,
    pub global_start: i64,
    pub global_end: i64,
}

#[derive(Debug, Clone)]
pub struct IndexedWikilinkRow {
    pub raw_target: String,
    pub alias: Option<String>,
    pub normalized_target: String,
    pub target_basename: String,
    pub ordinal: i64,
}

#[derive(Debug, Clone)]
pub struct IndexedDocument {
    pub note_uid: Option<i64>,
    pub doc_id: String,
    pub title: Option<String>,
    pub mtime_ms: i64,
    pub content_checksum: String,
    pub meta_json: String,
    pub chunks: Vec<IndexedChunkRow>,
    pub wikilink_refs: Vec<IndexedWikilinkRow>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredDocumentFreshness {
    pub mtime_ms: i64,
    pub content_checksum: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdvancedTitleRow {
    pub doc_id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdvancedBodyRow {
    pub doc_id: String,
    pub title: Option<String>,
    pub section_path: Vec<String>,
    pub section_ordinal: usize,
    pub kind: String,
    pub raw_text: String,
    pub global_start: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredWikilinkRefRow {
    pub rowid: i64,
    pub source_note_uid: i64,
    pub source_doc_id: String,
    pub raw_target: String,
    pub alias: Option<String>,
    pub normalized_target: String,
    pub target_basename: String,
    pub resolved_target_uid: Option<i64>,
    pub resolution_kind: String,
    pub folder_distance: Option<i64>,
    pub ordinal: i64,
}

const CREATE_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS documents (
    note_uid INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL UNIQUE,
    title TEXT,
    mtime_ms INTEGER NOT NULL,
    content_checksum TEXT,
    meta_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunk_rows (
    rowid INTEGER PRIMARY KEY,
    doc_id TEXT NOT NULL,
    section_path TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    raw_text TEXT NOT NULL,
    global_start INTEGER NOT NULL,
    global_end INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunk_doc ON chunk_rows(doc_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    doc_id UNINDEXED,
    section_path,
    kind UNINDEXED,
    text,
    content = 'chunk_rows',
    content_rowid = 'rowid',
    tokenize = 'unicode61',
    prefix = '2 3 4'
);

CREATE TRIGGER IF NOT EXISTS chunk_rows_ai AFTER INSERT ON chunk_rows BEGIN
  INSERT INTO chunks_fts(rowid, doc_id, section_path, kind, text)
  VALUES (new.rowid, new.doc_id, new.section_path, new.kind, new.text);
END;

CREATE TRIGGER IF NOT EXISTS chunk_rows_ad AFTER DELETE ON chunk_rows BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, doc_id, section_path, kind, text)
  VALUES ('delete', old.rowid, old.doc_id, old.section_path, old.kind, old.text);
END;

CREATE TRIGGER IF NOT EXISTS chunk_rows_au AFTER UPDATE ON chunk_rows BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, doc_id, section_path, kind, text)
  VALUES ('delete', old.rowid, old.doc_id, old.section_path, old.kind, old.text);
  INSERT INTO chunks_fts(rowid, doc_id, section_path, kind, text)
  VALUES (new.rowid, new.doc_id, new.section_path, new.kind, new.text);
END;

CREATE TABLE IF NOT EXISTS wikilink_refs (
    rowid INTEGER PRIMARY KEY,
    source_note_uid INTEGER NOT NULL,
    source_doc_id TEXT NOT NULL,
    raw_target TEXT NOT NULL,
    alias TEXT,
    normalized_target TEXT NOT NULL,
    target_basename TEXT NOT NULL,
    resolved_target_uid INTEGER,
    resolution_kind TEXT NOT NULL,
    folder_distance INTEGER,
    ordinal INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wikilink_source_uid ON wikilink_refs(source_note_uid);
CREATE INDEX IF NOT EXISTS idx_wikilink_normalized_target ON wikilink_refs(normalized_target);
CREATE INDEX IF NOT EXISTS idx_wikilink_target_basename ON wikilink_refs(target_basename);
CREATE INDEX IF NOT EXISTS idx_wikilink_resolved_target_uid ON wikilink_refs(resolved_target_uid);

CREATE TABLE IF NOT EXISTS search_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

pub fn open_connection(path: &Path) -> Result<Connection, String> {
    let (conn, _) = open_connection_with_outcome(path)?;
    Ok(conn)
}

pub fn prepare_search_db(path: &Path) -> Result<bool, String> {
    let (_conn, reset_applied) = open_connection_with_outcome(path)?;
    Ok(reset_applied)
}

fn open_connection_with_outcome(path: &Path) -> Result<(Connection, bool), String> {
    let conn = Connection::open(path).map_err(|e| format!("Failed to open search DB: {e}"))?;
    configure_connection(&conn)?;
    let reset_applied = init_schema(&conn)?;
    Ok((conn, reset_applied))
}

pub fn configure_connection(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        "#,
    )
    .map_err(|e| format!("Failed to configure search DB: {e}"))
}

pub fn init_schema(conn: &Connection) -> Result<bool, String> {
    let mut reset_applied = false;
    if schema_reset_required(conn)? {
        reset_schema(conn)?;
        reset_applied = true;
    }
    if version_reset_required(conn)? {
        reset_schema(conn)?;
        reset_applied = true;
    }

    conn.execute_batch(CREATE_SCHEMA_SQL)
        .map_err(|e| format!("Failed to initialize search schema: {e}"))?;

    ensure_documents_freshness_columns(conn)?;
    persist_index_version(conn)?;
    Ok(reset_applied)
}

pub fn replace_document(tx: &Transaction<'_>, doc: &IndexedDocument) -> Result<i64, String> {
    let note_uid = match doc.note_uid {
        Some(note_uid) => {
            tx.execute(
                "DELETE FROM chunk_rows
                 WHERE doc_id = ?1
                    OR doc_id IN (SELECT doc_id FROM documents WHERE note_uid = ?2)",
                params![doc.doc_id, note_uid],
            )
            .map_err(|e| format!("Failed to delete existing chunks: {e}"))?;
            tx.execute(
                "DELETE FROM documents WHERE doc_id = ?1 AND note_uid <> ?2",
                params![doc.doc_id, note_uid],
            )
            .map_err(|e| format!("Failed to delete conflicting document row: {e}"))?;
            tx.execute(
                "DELETE FROM wikilink_refs WHERE source_note_uid = ?1",
                params![note_uid],
            )
            .map_err(|e| format!("Failed to delete existing wikilinks: {e}"))?;
            tx.execute(
                r#"
                INSERT INTO documents (note_uid, doc_id, title, mtime_ms, content_checksum, meta_json)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT(note_uid) DO UPDATE SET
                    doc_id = excluded.doc_id,
                    title = excluded.title,
                    mtime_ms = excluded.mtime_ms,
                    content_checksum = excluded.content_checksum,
                    meta_json = excluded.meta_json
                "#,
                params![
                    note_uid,
                    doc.doc_id,
                    doc.title,
                    doc.mtime_ms,
                    doc.content_checksum,
                    doc.meta_json
                ],
            )
            .map_err(|e| format!("Failed to upsert document: {e}"))?;
            note_uid
        }
        None => {
            tx.execute(
                "DELETE FROM chunk_rows WHERE doc_id = ?",
                params![doc.doc_id],
            )
            .map_err(|e| format!("Failed to delete existing chunks: {e}"))?;
            tx.execute(
                "DELETE FROM documents WHERE doc_id = ?",
                params![doc.doc_id],
            )
            .map_err(|e| format!("Failed to delete existing document: {e}"))?;
            tx.execute(
                "INSERT INTO documents (doc_id, title, mtime_ms, content_checksum, meta_json) VALUES (?, ?, ?, ?, ?)",
                params![
                    doc.doc_id,
                    doc.title,
                    doc.mtime_ms,
                    doc.content_checksum,
                    doc.meta_json
                ],
            )
            .map_err(|e| format!("Failed to insert document: {e}"))?;
            tx.last_insert_rowid()
        }
    };

    for chunk in &doc.chunks {
        tx.execute(
            "INSERT INTO chunk_rows (doc_id, section_path, kind, text, raw_text, global_start, global_end)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                doc.doc_id,
                chunk.section_path_json,
                chunk.kind,
                chunk.text,
                chunk.raw_text,
                chunk.global_start,
                chunk.global_end
            ],
        )
        .map_err(|e| format!("Failed to insert chunk: {e}"))?;
    }

    for wikilink in &doc.wikilink_refs {
        tx.execute(
            r#"
            INSERT INTO wikilink_refs (
                source_note_uid,
                source_doc_id,
                raw_target,
                alias,
                normalized_target,
                target_basename,
                resolved_target_uid,
                resolution_kind,
                folder_distance,
                ordinal
            )
            VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)
            "#,
            params![
                note_uid,
                doc.doc_id,
                wikilink.raw_target,
                wikilink.alias,
                wikilink.normalized_target,
                wikilink.target_basename,
                RESOLUTION_UNRESOLVED,
                wikilink.ordinal
            ],
        )
        .map_err(|e| format!("Failed to insert wikilink ref: {e}"))?;
    }

    Ok(note_uid)
}

pub fn remove_document(tx: &Transaction<'_>, doc_id: &str) -> Result<Option<i64>, String> {
    let note_uid = tx
        .query_row(
            "SELECT note_uid FROM documents WHERE doc_id = ?1",
            params![doc_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| format!("Failed to load note uid: {e}"))?;

    if let Some(note_uid) = note_uid {
        tx.execute(
            "DELETE FROM wikilink_refs WHERE source_note_uid = ?",
            params![note_uid],
        )
        .map_err(|e| format!("Failed to delete wikilink refs: {e}"))?;
    }

    tx.execute("DELETE FROM chunk_rows WHERE doc_id = ?", params![doc_id])
        .map_err(|e| format!("Failed to delete chunks: {e}"))?;
    tx.execute("DELETE FROM documents WHERE doc_id = ?", params![doc_id])
        .map_err(|e| format!("Failed to delete document: {e}"))?;

    Ok(note_uid)
}

pub fn find_note_uid_by_doc_id(conn: &Connection, doc_id: &str) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT note_uid FROM documents WHERE doc_id = ?1",
        params![doc_id],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map_err(|e| format!("Failed to query note uid: {e}"))
}

pub fn find_note_uid_by_doc_id_nocase(
    conn: &Connection,
    doc_id: &str,
) -> Result<Option<i64>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT note_uid
             FROM documents
             WHERE doc_id = ?1 COLLATE NOCASE
             ORDER BY doc_id ASC
             LIMIT 2",
        )
        .map_err(|e| format!("Failed to prepare case-insensitive note uid query: {e}"))?;
    let rows = stmt
        .query_map(params![doc_id], |row| row.get::<_, i64>(0))
        .map_err(|e| format!("Failed to query case-insensitive note uid: {e}"))?;

    let mut matches = Vec::new();
    for row in rows {
        matches.push(row.map_err(|e| format!("Failed to read case-insensitive note uid: {e}"))?);
    }

    if matches.len() == 1 {
        Ok(Some(matches[0]))
    } else {
        Ok(None)
    }
}

pub fn list_indexed_doc_ids(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT doc_id FROM documents ORDER BY doc_id ASC")
        .map_err(|e| format!("Failed to list docs: {e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to query docs: {e}"))?;

    let mut ids = Vec::new();
    for row in rows {
        ids.push(row.map_err(|e| format!("Failed to read doc row: {e}"))?);
    }
    Ok(ids)
}

pub fn load_doc_identities(conn: &Connection) -> Result<Vec<DocIdentity>, String> {
    let mut stmt = conn
        .prepare("SELECT note_uid, doc_id FROM documents ORDER BY doc_id ASC")
        .map_err(|e| format!("Failed to prepare document identities query: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(to_doc_identity(
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
            ))
        })
        .map_err(|e| format!("Failed to execute document identities query: {e}"))?;

    let mut docs = Vec::new();
    for row in rows {
        docs.push(row.map_err(|e| format!("Failed to read document identity: {e}"))?);
    }
    Ok(docs)
}

pub fn load_document_freshness(
    conn: &Connection,
    doc_id: &str,
) -> Result<Option<StoredDocumentFreshness>, String> {
    conn.query_row(
        "SELECT mtime_ms, content_checksum FROM documents WHERE doc_id = ?1",
        params![doc_id],
        |row| {
            Ok(StoredDocumentFreshness {
                mtime_ms: row.get(0)?,
                content_checksum: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("Failed to query document freshness: {e}"))
}

pub fn update_document_freshness(
    tx: &Transaction<'_>,
    doc_id: &str,
    mtime_ms: i64,
    content_checksum: &str,
) -> Result<(), String> {
    tx.execute(
        "UPDATE documents
         SET mtime_ms = ?2,
             content_checksum = ?3
         WHERE doc_id = ?1",
        params![doc_id, mtime_ms, content_checksum],
    )
    .map_err(|e| format!("Failed to update document freshness: {e}"))?;
    Ok(())
}

pub fn load_wikilink_rows(conn: &Connection) -> Result<Vec<StoredWikilinkRefRow>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
                rowid,
                source_note_uid,
                source_doc_id,
                raw_target,
                alias,
                normalized_target,
                target_basename,
                resolved_target_uid,
                resolution_kind,
                folder_distance,
                ordinal
            FROM wikilink_refs
            ORDER BY source_doc_id ASC, ordinal ASC, rowid ASC
            "#,
        )
        .map_err(|e| format!("Failed to prepare wikilink row query: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(StoredWikilinkRefRow {
                rowid: row.get(0)?,
                source_note_uid: row.get(1)?,
                source_doc_id: row.get(2)?,
                raw_target: row.get(3)?,
                alias: row.get(4)?,
                normalized_target: row.get(5)?,
                target_basename: row.get(6)?,
                resolved_target_uid: row.get(7)?,
                resolution_kind: row.get(8)?,
                folder_distance: row.get(9)?,
                ordinal: row.get(10)?,
            })
        })
        .map_err(|e| format!("Failed to execute wikilink row query: {e}"))?;

    let mut refs = Vec::new();
    for row in rows {
        refs.push(row.map_err(|e| format!("Failed to read wikilink row: {e}"))?);
    }
    Ok(refs)
}

pub fn update_wikilink_resolution(
    tx: &Transaction<'_>,
    rowid: i64,
    resolution: &LinkResolution,
) -> Result<(), String> {
    tx.execute(
        r#"
        UPDATE wikilink_refs
        SET resolved_target_uid = ?1,
            resolution_kind = ?2,
            folder_distance = ?3
        WHERE rowid = ?4
        "#,
        params![
            resolution.resolved_target_uid,
            resolution.resolution_kind,
            resolution.folder_distance,
            rowid
        ],
    )
    .map_err(|e| format!("Failed to update wikilink resolution: {e}"))?;
    Ok(())
}

pub fn load_link_counts(conn: &Connection) -> Result<(usize, usize, usize), String> {
    let resolved = count_by_resolution(conn, "resolved_target_uid IS NOT NULL")?;
    let unresolved = count_by_resolution(conn, "resolution_kind = 'unresolved'")?;
    let ambiguous = count_by_resolution(conn, "resolution_kind = 'ambiguous'")?;
    Ok((resolved, unresolved, ambiguous))
}

pub fn query_metadata_hits(
    conn: &Connection,
    normalized_query: &str,
    limit: usize,
) -> Result<Vec<SimpleSearchHit>, String> {
    let like = format!("%{normalized_query}%");
    let mut stmt = conn
        .prepare(
            r#"
            SELECT doc_id, title, meta_json
            FROM documents
            WHERE lower(COALESCE(title, '')) LIKE ?1
               OR lower(COALESCE(meta_json, '')) LIKE ?1
            ORDER BY doc_id ASC
            LIMIT ?2
            "#,
        )
        .map_err(|e| format!("Failed to prepare metadata query: {e}"))?;

    let rows = stmt
        .query_map(params![like, limit as i64], |row| {
            let doc_id: String = row.get(0)?;
            let title: Option<String> = row.get(1)?;
            let meta_json: String = row.get(2)?;
            Ok(SimpleSearchHit {
                doc_id,
                title: title.clone(),
                section_path: Vec::new(),
                section_ordinal: 0,
                snippet: title.unwrap_or(meta_json),
                kind: "Heading".to_string(),
                score: 1_000_000.0,
            })
        })
        .map_err(|e| format!("Failed to execute metadata query: {e}"))?;

    let mut hits = Vec::new();
    for row in rows {
        hits.push(row.map_err(|e| format!("Failed to read metadata hit: {e}"))?);
    }
    Ok(hits)
}

pub fn query_body_hits(
    conn: &Connection,
    fts_query: &str,
    limit: usize,
    snippet_builder: impl Fn(&str) -> String,
) -> Result<Vec<SimpleSearchHit>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
                cr.doc_id,
                d.title,
                cr.section_path,
                CASE
                    WHEN cr.section_path = '[]' THEN 0
                    ELSE MAX(0, (
                        SELECT COUNT(*)
                        FROM chunk_rows anchors
                        WHERE anchors.doc_id = cr.doc_id
                          AND anchors.section_path = cr.section_path
                          AND anchors.kind = 'Heading'
                          AND anchors.global_start <= cr.global_start
                    ) - 1)
                END AS section_ordinal,
                cr.kind,
                cr.raw_text,
                -bm25(chunks_fts) AS score
            FROM chunks_fts
            JOIN chunk_rows cr ON cr.rowid = chunks_fts.rowid
            LEFT JOIN documents d ON d.doc_id = cr.doc_id
            WHERE chunks_fts MATCH ?1
            ORDER BY score DESC, cr.doc_id ASC
            LIMIT ?2
            "#,
        )
        .map_err(|e| format!("Failed to prepare body query: {e}"))?;

    let rows = stmt
        .query_map(params![fts_query, limit as i64], |row| {
            let doc_id: String = row.get(0)?;
            let title: Option<String> = row.get(1)?;
            let section_path_json: String = row.get(2)?;
            let section_ordinal: usize = row.get(3)?;
            let kind: String = row.get(4)?;
            let raw_text: String = row.get(5)?;
            let score: f64 = row.get(6)?;
            let section_path =
                serde_json::from_str::<Vec<String>>(&section_path_json).unwrap_or_default();
            Ok(SimpleSearchHit {
                doc_id,
                title,
                section_path,
                section_ordinal,
                snippet: snippet_builder(&raw_text),
                kind,
                score,
            })
        })
        .map_err(|e| format!("Failed to execute body query: {e}"))?;

    let mut hits = Vec::new();
    for row in rows {
        hits.push(row.map_err(|e| format!("Failed to read body hit: {e}"))?);
    }
    Ok(hits)
}

pub fn visit_advanced_title_rows(
    conn: &Connection,
    mut visit: impl FnMut(AdvancedTitleRow) -> Result<bool, String>,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT doc_id, title
            FROM documents
            WHERE title IS NOT NULL AND title <> ''
            ORDER BY doc_id ASC
            "#,
        )
        .map_err(|e| format!("Failed to prepare advanced title query: {e}"))?;

    let mut rows = stmt
        .query([])
        .map_err(|e| format!("Failed to execute advanced title query: {e}"))?;

    while let Some(row) = rows
        .next()
        .map_err(|e| format!("Failed to read advanced title row: {e}"))?
    {
        let should_continue = visit(AdvancedTitleRow {
            doc_id: row
                .get(0)
                .map_err(|e| format!("Failed to read advanced title row: {e}"))?,
            title: row
                .get(1)
                .map_err(|e| format!("Failed to read advanced title row: {e}"))?,
        })?;
        if !should_continue {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
pub fn load_advanced_title_rows(conn: &Connection) -> Result<Vec<AdvancedTitleRow>, String> {
    let mut titles = Vec::new();
    visit_advanced_title_rows(conn, |row| {
        titles.push(row);
        Ok(true)
    })?;
    Ok(titles)
}

pub fn visit_advanced_body_rows(
    conn: &Connection,
    mut visit: impl FnMut(AdvancedBodyRow) -> Result<bool, String>,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
                cr.doc_id,
                d.title,
                cr.section_path,
                cr.kind,
                cr.raw_text,
                cr.global_start
            FROM chunk_rows cr
            LEFT JOIN documents d ON d.doc_id = cr.doc_id
            ORDER BY cr.doc_id ASC, cr.section_path ASC, cr.global_start ASC
            "#,
        )
        .map_err(|e| format!("Failed to prepare advanced body query: {e}"))?;

    let mut rows = stmt
        .query([])
        .map_err(|e| format!("Failed to execute advanced body query: {e}"))?;
    let mut current_key: Option<(String, String)> = None;
    let mut heading_count = 0usize;

    while let Some(row) = rows
        .next()
        .map_err(|e| format!("Failed to read advanced body row: {e}"))?
    {
        let doc_id: String = row
            .get(0)
            .map_err(|e| format!("Failed to read advanced body row: {e}"))?;
        let title: Option<String> = row
            .get(1)
            .map_err(|e| format!("Failed to read advanced body row: {e}"))?;
        let section_path_json: String = row
            .get(2)
            .map_err(|e| format!("Failed to read advanced body row: {e}"))?;
        let kind: String = row
            .get(3)
            .map_err(|e| format!("Failed to read advanced body row: {e}"))?;
        let raw_text: String = row
            .get(4)
            .map_err(|e| format!("Failed to read advanced body row: {e}"))?;
        let global_start: i64 = row
            .get(5)
            .map_err(|e| format!("Failed to read advanced body row: {e}"))?;
        let section_path =
            serde_json::from_str::<Vec<String>>(&section_path_json).unwrap_or_default();
        let key = (doc_id.clone(), section_path_json);
        if current_key.as_ref() != Some(&key) {
            current_key = Some(key);
            heading_count = 0;
        }

        let section_ordinal = if section_path.is_empty() {
            0
        } else if kind == "Heading" {
            let ordinal = heading_count;
            heading_count += 1;
            ordinal
        } else {
            heading_count.saturating_sub(1)
        };

        let should_continue = visit(AdvancedBodyRow {
            doc_id,
            title,
            section_path,
            section_ordinal,
            kind,
            raw_text,
            global_start,
        })?;
        if !should_continue {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
pub fn load_advanced_body_rows(conn: &Connection) -> Result<Vec<AdvancedBodyRow>, String> {
    let mut body_rows = Vec::new();
    visit_advanced_body_rows(conn, |row| {
        body_rows.push(row);
        Ok(true)
    })?;
    Ok(body_rows)
}

fn count_by_resolution(conn: &Connection, predicate_sql: &str) -> Result<usize, String> {
    conn.query_row(
        &format!("SELECT COUNT(*) FROM wikilink_refs WHERE {predicate_sql}"),
        [],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count as usize)
    .map_err(|e| format!("Failed to count wikilink refs: {e}"))
}

fn schema_reset_required(conn: &Connection) -> Result<bool, String> {
    let has_documents = table_exists(conn, "documents")?;
    if !has_documents {
        return Ok(false);
    }

    Ok(!table_has_column(conn, "documents", "note_uid")?)
}

fn ensure_documents_freshness_columns(conn: &Connection) -> Result<(), String> {
    if !table_exists(conn, "documents")? {
        return Ok(());
    }

    if !table_has_column(conn, "documents", "content_checksum")? {
        conn.execute("ALTER TABLE documents ADD COLUMN content_checksum TEXT", [])
            .map_err(|e| format!("Failed to add content_checksum column: {e}"))?;
    }

    Ok(())
}

fn version_reset_required(conn: &Connection) -> Result<bool, String> {
    if !has_existing_search_state(conn)? {
        return Ok(false);
    }

    let Some(version) = load_index_version(conn)? else {
        return Ok(true);
    };

    Ok(version != CURRENT_INDEX_VERSION)
}

fn has_existing_search_state(conn: &Connection) -> Result<bool, String> {
    Ok(table_exists(conn, "documents")?
        || table_exists(conn, "chunk_rows")?
        || table_exists(conn, "wikilink_refs")?
        || table_exists(conn, "chunks_fts")?)
}

fn load_index_version(conn: &Connection) -> Result<Option<i64>, String> {
    if !table_exists(conn, "search_metadata")? {
        return Ok(None);
    }

    let value = conn
        .query_row(
            "SELECT value FROM search_metadata WHERE key = ?1",
            params![INDEX_VERSION_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("Failed to query index version: {e}"))?;

    value
        .map(|raw| {
            raw.parse::<i64>()
                .map_err(|e| format!("Failed to parse stored index version: {e}"))
        })
        .transpose()
}

fn persist_index_version(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "INSERT INTO search_metadata(key, value)
         VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![INDEX_VERSION_KEY, CURRENT_INDEX_VERSION.to_string()],
    )
    .map_err(|e| format!("Failed to persist index version: {e}"))?;
    Ok(())
}

fn table_exists(conn: &Connection, table_name: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?1)",
        params![table_name],
        |row| row.get::<_, i64>(0),
    )
    .map(|exists| exists != 0)
    .map_err(|e| format!("Failed to inspect sqlite schema: {e}"))
}

fn table_has_column(
    conn: &Connection,
    table_name: &str,
    column_name: &str,
) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table_name})"))
        .map_err(|e| format!("Failed to inspect table columns: {e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("Failed to query table columns: {e}"))?;

    for row in rows {
        if row.map_err(|e| format!("Failed to read table column: {e}"))? == column_name {
            return Ok(true);
        }
    }

    Ok(false)
}

fn reset_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        DROP TRIGGER IF EXISTS chunk_rows_ai;
        DROP TRIGGER IF EXISTS chunk_rows_ad;
        DROP TRIGGER IF EXISTS chunk_rows_au;
        DROP TABLE IF EXISTS wikilink_refs;
        DROP TABLE IF EXISTS chunk_rows;
        DROP TABLE IF EXISTS documents;
        DROP TABLE IF EXISTS chunks_fts;
        DROP TABLE IF EXISTS search_metadata;
        "#,
    )
    .map_err(|e| format!("Failed to reset legacy search schema: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_content_trigger_sync_removes_deleted_rows() {
        let conn = Connection::open_in_memory().unwrap();
        configure_connection(&conn).unwrap();
        init_schema(&conn).unwrap();

        conn.execute(
            "INSERT INTO documents (doc_id, title, mtime_ms, meta_json) VALUES ('a.md', 'A', 1, '{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chunk_rows (doc_id, section_path, kind, text, raw_text, global_start, global_end)
             VALUES ('a.md', '[]', 'Prose', 'hello world', 'hello world', 0, 11)",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM chunk_rows WHERE doc_id = 'a.md'", [])
            .unwrap();

        let exists = query_body_hits(&conn, "hello*", 10, |raw| raw.to_string()).unwrap();
        assert!(exists.is_empty());
    }

    #[test]
    fn advanced_materialization_preserves_sort_fields() {
        let mut conn = Connection::open_in_memory().unwrap();
        configure_connection(&conn).unwrap();
        init_schema(&conn).unwrap();

        let tx = conn.transaction().unwrap();
        replace_document(
            &tx,
            &IndexedDocument {
                note_uid: None,
                doc_id: "note.md".to_string(),
                title: Some("Alpha Title".to_string()),
                mtime_ms: 1,
                content_checksum: "checksum:note.md".to_string(),
                meta_json: "{}".to_string(),
                chunks: vec![IndexedChunkRow {
                    section_path_json: serde_json::to_string(&vec!["Section".to_string()]).unwrap(),
                    kind: "Prose".to_string(),
                    text: "alpha body".to_string(),
                    raw_text: "Alpha body".to_string(),
                    global_start: 12,
                    global_end: 22,
                }],
                wikilink_refs: vec![],
            },
        )
        .unwrap();
        tx.commit().unwrap();

        let titles = load_advanced_title_rows(&conn).unwrap();
        let body_rows = load_advanced_body_rows(&conn).unwrap();

        assert_eq!(
            titles,
            vec![AdvancedTitleRow {
                doc_id: "note.md".to_string(),
                title: "Alpha Title".to_string(),
            }]
        );
        assert_eq!(body_rows.len(), 1);
        assert_eq!(body_rows[0].section_path, vec!["Section".to_string()]);
        assert_eq!(body_rows[0].section_ordinal, 0);
        assert_eq!(body_rows[0].global_start, 12);
    }

    #[test]
    fn replace_document_persists_wikilinks() {
        let mut conn = Connection::open_in_memory().unwrap();
        configure_connection(&conn).unwrap();
        init_schema(&conn).unwrap();

        let tx = conn.transaction().unwrap();
        let note_uid = replace_document(
            &tx,
            &IndexedDocument {
                note_uid: None,
                doc_id: "note.md".to_string(),
                title: None,
                mtime_ms: 1,
                content_checksum: "checksum:note.md".to_string(),
                meta_json: "{}".to_string(),
                chunks: vec![],
                wikilink_refs: vec![IndexedWikilinkRow {
                    raw_target: "target".to_string(),
                    alias: Some("alias".to_string()),
                    normalized_target: "target".to_string(),
                    target_basename: "target".to_string(),
                    ordinal: 0,
                }],
            },
        )
        .unwrap();
        tx.commit().unwrap();

        let refs = load_wikilink_rows(&conn).unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].source_note_uid, note_uid);
        assert_eq!(refs[0].raw_target, "target");
    }

    #[test]
    fn init_schema_resets_existing_schema_when_index_version_metadata_is_missing() {
        let conn = Connection::open_in_memory().unwrap();
        configure_connection(&conn).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE documents (
                note_uid INTEGER PRIMARY KEY AUTOINCREMENT,
                doc_id TEXT NOT NULL UNIQUE,
                title TEXT,
                mtime_ms INTEGER NOT NULL,
                meta_json TEXT NOT NULL
            );
            "#,
        )
        .unwrap();

        assert!(init_schema(&conn).unwrap());

        assert!(table_has_column(&conn, "documents", "content_checksum").unwrap());
        assert_eq!(load_index_version(&conn).unwrap(), Some(CURRENT_INDEX_VERSION));
    }

    #[test]
    fn init_schema_resets_existing_index_on_version_mismatch() {
        let conn = Connection::open_in_memory().unwrap();
        configure_connection(&conn).unwrap();
        conn.execute_batch(CREATE_SCHEMA_SQL).unwrap();
        conn.execute(
            "INSERT INTO search_metadata(key, value) VALUES (?1, ?2)",
            params![INDEX_VERSION_KEY, "0"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO documents (doc_id, title, mtime_ms, content_checksum, meta_json)
             VALUES ('note.md', 'Old', 1, 'checksum', '{}')",
            [],
        )
        .unwrap();

        assert!(init_schema(&conn).unwrap());

        let doc_count = conn
            .query_row("SELECT COUNT(*) FROM documents", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        assert_eq!(doc_count, 0);
        assert_eq!(
            load_index_version(&conn).unwrap(),
            Some(CURRENT_INDEX_VERSION)
        );
    }
}
