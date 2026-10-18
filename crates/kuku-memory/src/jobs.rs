//! Durable, local-only extraction inputs. Results are proposals, never direct writes.
use crate::{Result, Store, digest, now};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
impl Store {
    fn jobs_schema(&self) -> Result<()> {
        self.db.execute_batch("CREATE TABLE IF NOT EXISTS extraction_jobs(id TEXT PRIMARY KEY,input TEXT NOT NULL,state TEXT NOT NULL,result TEXT,updated_at TEXT NOT NULL)").map_err(|e|e.to_string())
    }
    pub fn begin_extraction(&self, input: &Value) -> Result<(String, Option<Value>)> {
        self.jobs_schema()?;
        let text = serde_json::to_string(input).map_err(|e| e.to_string())?;
        if text.len() > 200000 {
            return Err("Extraction input is too large".into());
        }
        let id = format!("extract_{}", digest(text.as_bytes()));
        let previous: Option<String> = self
            .db
            .query_row(
                "SELECT result FROM extraction_jobs WHERE id=?1 AND state='completed'",
                [&id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(result) = previous {
            return Ok((
                id,
                Some(serde_json::from_str(&result).map_err(|e| e.to_string())?),
            ));
        }
        self.db.execute("INSERT INTO extraction_jobs VALUES(?1,?2,'processing',NULL,?3) ON CONFLICT(id) DO UPDATE SET state='processing',updated_at=excluded.updated_at",params![id,text,now()]).map_err(|e|e.to_string())?;
        Ok((id, None))
    }
    pub fn finish_extraction(&self, id: &str, result: Option<&Value>) -> Result<()> {
        self.jobs_schema()?;
        self.db
            .execute(
                "UPDATE extraction_jobs SET state=?2,result=?3,updated_at=?4 WHERE id=?1",
                params![
                    id,
                    if result.is_some() {
                        "completed"
                    } else {
                        "failed"
                    },
                    result
                        .map(serde_json::to_string)
                        .transpose()
                        .map_err(|e| e.to_string())?,
                    now()
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn extraction_jobs(&self) -> Result<Value> {
        self.jobs_schema()?;
        let mut stmt=self.db.prepare("SELECT id,state,updated_at,input FROM extraction_jobs ORDER BY updated_at DESC LIMIT 20").map_err(|e|e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut jobs = vec![];
        for row in rows {
            let (id, state, updated, input) = row.map_err(|e| e.to_string())?;
            let data: Value = serde_json::from_str(&input).map_err(|e| e.to_string())?;
            jobs.push(json!({"id":id,"state":state,"updated_at":updated,"paths":data["notes"].as_object().map(|n|n.keys().collect::<Vec<_>>()).unwrap_or_default()}));
        }
        Ok(json!(jobs))
    }
}
