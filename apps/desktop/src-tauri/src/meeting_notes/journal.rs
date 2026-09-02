//! Durable handoff between inference and document saving. Events are notifications,
//! never the only copy of a transcript. A journal is removed only after disk ACK.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, io::Write, path::PathBuf, sync::Mutex};

use super::controller::TranscriptPayload;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingTarget {
    pub vault_root: String,
    pub file_path: String,
    pub title: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCheckpoint {
    pub content: String,
    pub expected_checksum: String,
    pub doc: Value,
    pub from: u32,
    pub to: u32,
    pub finalized: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingJournal {
    pub session_id: String,
    pub target: MeetingTarget,
    pub checkpoint: DocumentCheckpoint,
    pub transcript: Option<TranscriptPayload>,
}

pub struct JournalStore {
    root: Result<PathBuf, String>,
    lock: Mutex<()>,
}

pub fn validate_id(id: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| "Invalid meeting session ID".into())
}

impl JournalStore {
    pub fn new(root: Result<PathBuf, String>) -> Self {
        Self {
            root,
            lock: Mutex::new(()),
        }
    }

    fn path(&self, id: &str) -> Result<PathBuf, String> {
        validate_id(id)?;
        Ok(self
            .root
            .as_ref()
            .map_err(Clone::clone)?
            .join(format!("{id}.json")))
    }

    fn read(&self, id: &str) -> Result<MeetingJournal, String> {
        serde_json::from_slice(&fs::read(self.path(id)?).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())
    }

    fn write(&self, entry: &MeetingJournal) -> Result<(), String> {
        let path = self.path(&entry.session_id)?;
        let root = path.parent().ok_or("Missing journal directory")?;
        fs::create_dir_all(root).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        let temp = path.with_extension("pending");
        let mut file = fs::File::create(&temp).map_err(|e| e.to_string())?;
        let content = serde_json::to_vec(entry).map_err(|e| e.to_string())?;
        file.write_all(&content)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        fs::rename(temp, &path).map_err(|e| e.to_string())?;
        fs::File::open(root)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())
    }

    pub fn create(
        &self,
        id: &str,
        target: MeetingTarget,
        checkpoint: DocumentCheckpoint,
    ) -> Result<(), String> {
        let _lock = self.lock.lock().map_err(|_| "Journal lock failed")?;
        if self.path(id)?.exists() {
            return Err("Meeting session already exists".into());
        }
        self.write(&MeetingJournal {
            session_id: id.into(),
            target,
            checkpoint,
            transcript: None,
        })
    }

    pub fn transcript(&self, transcript: &TranscriptPayload) -> Result<(), String> {
        let _lock = self.lock.lock().map_err(|_| "Journal lock failed")?;
        let mut entry = self.read(&transcript.session_id)?;
        // Late live events cannot replace an authoritative final result.
        if entry.transcript.as_ref().is_some_and(|p| p.kind == "final") {
            return Ok(());
        }
        entry.transcript = Some(transcript.clone());
        self.write(&entry)
    }

    pub fn checkpoint(&self, id: &str, checkpoint: DocumentCheckpoint) -> Result<(), String> {
        let _lock = self.lock.lock().map_err(|_| "Journal lock failed")?;
        let mut entry = self.read(id)?;
        entry.checkpoint = checkpoint;
        self.write(&entry)
    }

    pub fn get(&self, id: &str) -> Result<MeetingJournal, String> {
        let _lock = self.lock.lock().map_err(|_| "Journal lock failed")?;
        self.read(id)
    }

    pub fn list(&self) -> Result<Vec<MeetingJournal>, String> {
        let _lock = self.lock.lock().map_err(|_| "Journal lock failed")?;
        let root = self.root.as_ref().map_err(Clone::clone)?;
        if !root.exists() {
            return Ok(vec![]);
        }
        let mut entries = Vec::new();
        for item in fs::read_dir(root).map_err(|e| e.to_string())? {
            let path = item.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                let bytes = fs::read(path).map_err(|e| e.to_string())?;
                entries.push(
                    serde_json::from_slice(&bytes)
                        .map_err(|e| format!("Unreadable recovery journal: {e}"))?,
                );
            }
        }
        Ok(entries)
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let _lock = self.lock.lock().map_err(|_| "Journal lock failed")?;
        let path = self.path(id)?;
        // Remove audio before the journal so a failure remains discoverable.
        for extension in ["wav", "pcm", "pending", "json"] {
            match fs::remove_file(path.with_extension(extension)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(())
    }

    pub fn discard_all(&self) -> Result<(), String> {
        let _lock = self.lock.lock().map_err(|_| "Journal lock failed")?;
        let root = self.root.as_ref().map_err(Clone::clone)?;
        if !root.exists() {
            return Ok(());
        }
        match fs::remove_dir_all(root) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn final_survives_restart_and_late_events_until_acknowledged() {
        let root = std::env::temp_dir().join(format!("kuku-journal-{}", uuid::Uuid::new_v4()));
        let id = uuid::Uuid::new_v4().to_string();
        let store = JournalStore::new(Ok(root.clone()));
        store
            .create(
                &id,
                MeetingTarget {
                    vault_root: "/vault".into(),
                    file_path: "note.md".into(),
                    title: "Meeting".into(),
                },
                DocumentCheckpoint {
                    content: "Original".into(),
                    expected_checksum: "checksum".into(),
                    doc: serde_json::json!({"type":"doc"}),
                    from: 0,
                    to: 0,
                    finalized: false,
                },
            )
            .unwrap();
        let mut transcript = TranscriptPayload {
            session_id: id.clone(),
            kind: "final".into(),
            stable_text: "Complete text".into(),
            unstable_text: String::new(),
            speaker_id: None,
            segments: vec![],
            speaker_limit_warning: false,
        };
        store.transcript(&transcript).unwrap();
        transcript.kind = "update".into();
        transcript.stable_text = "Stale".into();
        store.transcript(&transcript).unwrap();
        drop(store);
        let store = JournalStore::new(Ok(root.clone()));
        assert_eq!(
            store.list().unwrap()[0]
                .transcript
                .as_ref()
                .unwrap()
                .stable_text,
            "Complete text"
        );
        assert!(store.get("../../escape").is_err());
        fs::write(root.join(format!("{id}.wav")), b"audio").unwrap();
        store.remove(&id).unwrap();
        assert!(store.list().unwrap().is_empty());
        assert!(!root.join(format!("{id}.wav")).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn discards_corrupt_and_unrecognized_temporary_files_without_parsing() {
        let root = std::env::temp_dir().join(format!("kuku-journal-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("broken.json"), b"{not-json").unwrap();
        fs::write(root.join("orphan.wav"), b"audio").unwrap();
        fs::write(root.join("orphan.pcm"), b"pcm").unwrap();
        fs::create_dir(root.join("nested")).unwrap();
        let store = JournalStore::new(Ok(root.clone()));

        store.discard_all().unwrap();

        assert!(!root.join("broken.json").exists());
        assert!(!root.join("orphan.wav").exists());
        assert!(!root.join("orphan.pcm").exists());
        assert!(!root.exists());
    }
}
