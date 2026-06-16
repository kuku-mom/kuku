use automerge::transaction::Transactable;
use automerge::{ActorId, AutoCommit, ObjId, ObjType, ROOT, ReadDoc, Value};

use crate::error::{Result, SyncCoreError};

pub(crate) const TEXT_BODY: &str = "body";

pub(crate) struct TextDocument {
    pub(crate) doc_id: String,
    pub(crate) doc: AutoCommit,
}

impl TextDocument {
    pub(crate) fn new(actor: impl AsRef<[u8]>, doc_id: String, content: String) -> Result<Self> {
        let mut doc = AutoCommit::new();
        doc.set_actor(ActorId::from(actor.as_ref()));
        let body = doc.put_object(&ROOT, TEXT_BODY, ObjType::Text)?;
        doc.update_text(&body, content)?;
        doc.commit();
        Ok(Self { doc_id, doc })
    }

    pub(crate) fn load(actor: impl AsRef<[u8]>, doc_id: String, bytes: &[u8]) -> Result<Self> {
        let mut doc = AutoCommit::load(bytes)?;
        doc.set_actor(ActorId::from(actor.as_ref()));
        Ok(Self { doc_id, doc })
    }

    pub(crate) fn fork_for_actor(&mut self, actor: impl AsRef<[u8]>) -> Result<Self> {
        let mut doc = AutoCommit::load(&self.doc.save())?;
        doc.set_actor(ActorId::from(actor.as_ref()));
        Ok(Self {
            doc_id: self.doc_id.clone(),
            doc,
        })
    }

    pub(crate) fn save(&mut self) -> Vec<u8> {
        self.doc.save()
    }

    pub(crate) fn merge_from(&mut self, other: &mut Self) -> Result<()> {
        self.doc.merge(&mut other.doc)?;
        Ok(())
    }

    pub(crate) fn set_content(&mut self, content: String) -> Result<()> {
        let body = self.body_obj()?;
        self.doc.update_text(&body, content)?;
        self.doc.commit();
        Ok(())
    }

    pub(crate) fn content(&mut self) -> Result<String> {
        let body = self.body_obj()?;
        Ok(self.doc.text(&body)?)
    }

    fn body_obj(&self) -> Result<ObjId> {
        match self.doc.get(&ROOT, TEXT_BODY)? {
            Some((Value::Object(ObjType::Text), obj)) => Ok(obj),
            Some(_) => Err(SyncCoreError::ExpectedObject { field: TEXT_BODY }),
            None => Err(SyncCoreError::MissingTextBody),
        }
    }
}
