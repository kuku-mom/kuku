use super::*;
fn actor() -> Actor {
    Actor {
        client: "test-client".into(),
        scopes: vec!["personal".into()],
        auto_scopes: vec!["personal".into()],
    }
}
fn request() -> Remember {
    Remember {
        request_id: "req_1".into(),
        scope: "personal".into(),
        title: "언어 선호".into(),
        body: "설명은 한국어로 작성한다. Code comments in English.".into(),
        id: None,
        expected_version: None,
        kind: Some("preference".into()),
        tags: vec![],
        source_refs: vec![],
        expires_at: None,
    }
}
#[test]
fn retries_updates_isolation_and_undo() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let actor = actor();
    let saved = store.remember(&actor, request()).unwrap();
    assert_eq!(saved.status, "committed");
    assert_eq!(store.remember(&actor, request()).unwrap().id, saved.id);
    let mut reused = request();
    reused.body = "different".into();
    assert!(store.remember(&actor, reused).is_err());
    assert_eq!(store.search(&actor, "한국어", None, 5).unwrap().len(), 1);
    assert_eq!(store.search(&actor, "English", None, 5).unwrap().len(), 1);
    let other = Actor {
        client: "other".into(),
        scopes: vec!["other".into()],
        auto_scopes: vec![],
    };
    assert!(store.read(&other, &saved.id).is_err());
    assert!(store.search(&other, "", None, 50).unwrap().is_empty());
    let mut edit = request();
    edit.request_id = "req_2".into();
    edit.id = Some(saved.id.clone());
    edit.expected_version = Some(1);
    edit.body = "정정된 선호".into();
    assert_eq!(store.remember(&actor, edit.clone()).unwrap().version, 2);
    edit.request_id = "req_3".into();
    assert_eq!(store.remember(&actor, edit).unwrap().status, "conflict");
    let history = store.history(&actor).unwrap();
    let seq = history[0]["seq"].as_i64().unwrap();
    assert!(store.undo(&actor, seq).unwrap().body.contains("한국어"));
    assert!(store.undo(&actor, seq).is_err());
}
#[test]
fn proposals_do_not_replace_current_memory() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let mut actor = actor();
    let saved = store.remember(&actor, request()).unwrap();
    actor.auto_scopes.clear();
    let mut edit = request();
    edit.id = Some(saved.id.clone());
    edit.expected_version = Some(1);
    edit.request_id = "edit".into();
    edit.body = "pending".into();
    assert_eq!(store.remember(&actor, edit).unwrap().status, "proposed");
    assert_ne!(store.read(&actor, &saved.id).unwrap().body, "pending");
}
#[test]
fn deleted_memory_and_cloud_outbox_survive_reopen() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let a = actor();
    let s = store.remember(&a, request()).unwrap();
    store.manage(&a, &s.id, 1, "share").unwrap();
    assert_eq!(store.pending_cloud().unwrap().len(), 1);
    store.manage(&a, &s.id, 2, "delete").unwrap();
    drop(store);
    let store = Store::open(root.path()).unwrap();
    assert!(store.search(&a, "", None, 5).unwrap().is_empty());
    assert!(store.read(&a, &s.id).is_err());
    assert_eq!(store.pending_cloud().unwrap()[0]["expected_version"], 0);
}
#[test]
fn markdown_edits_and_index_rebuild() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let a = actor();
    let saved = store.remember(&a, request()).unwrap();
    drop(store);
    let path = root
        .path()
        .join(format!("Knowledge/memory/{}.md", saved.id));
    let text = fs::read_to_string(&path)
        .unwrap()
        .replace("설명은 한국어로 작성한다.", "설명은 일본어로 작성한다.");
    fs::write(path, text).unwrap();
    store = Store::open(root.path()).unwrap();
    assert_eq!(store.read(&a, &saved.id).unwrap().version, 2);
    assert_eq!(store.search(&a, "일본어", None, 5).unwrap().len(), 1);
}
#[cfg(unix)]
#[test]
fn rejects_symlinked_store() {
    let root = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(other.path(), root.path().join(".kuku")).unwrap();
    assert!(Store::open(root.path()).is_err());
}

#[test]
fn cloud_ack_preserves_inflight_edits_and_account_binding() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let a = actor();
    store.bind_cloud_account("user-a").unwrap();
    assert!(store.bind_cloud_account("user-b").is_err());
    let saved = store.remember_in_scope(&a, request(), true).unwrap();
    let first = store.read(&a, &saved.id).unwrap();
    let pending = store.pending_cloud().unwrap();
    let receipt = pending[0]["request_id"].as_str().unwrap().to_string();
    let mut edit = request();
    edit.request_id = "inflight-edit".into();
    edit.id = Some(saved.id.clone());
    edit.expected_version = Some(1);
    edit.body = "new local edit".into();
    store.remember(&a, edit).unwrap();
    store.cloud_ack(&saved.id, &receipt, &first).unwrap();
    assert_eq!(store.read(&a, &saved.id).unwrap().body, "new local edit");
    assert_eq!(store.pending_cloud().unwrap()[0]["expected_version"], 1);
}
#[test]
fn file_deletion_rebuild_and_expiration() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let a = actor();
    let saved = store.remember(&a, request()).unwrap();
    store.rebuild_index().unwrap();
    assert_eq!(store.search(&a, "한국어", None, 5).unwrap().len(), 1);
    let mut m = store.read(&a, &saved.id).unwrap();
    m.expires_at = Some("2000-01-01T00:00:00Z".into());
    let path = root
        .path()
        .join(format!("Knowledge/memory/{}.md", saved.id));
    drop(store);
    fs::write(&path, markdown(&m).unwrap()).unwrap();
    let store = Store::open(root.path()).unwrap();
    assert!(store.search(&a, "", None, 5).unwrap().is_empty());
    assert!(store.read_active(&a, &saved.id).is_err());
    drop(store);
    fs::remove_file(path).unwrap();
    let store = Store::open(root.path()).unwrap();
    assert!(store.read(&a, &saved.id).is_err());
}

#[test]
fn unsharing_stays_private_on_edit_and_explicit_resharing_uses_cloud_version() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let a = actor();
    let outcome = store.remember_in_scope(&a, request(), true).unwrap();
    let id = outcome.id;
    let original = store.read(&a, &id).unwrap();
    store.cloud_ack(&id, "req_1", &original).unwrap();
    let unshared = store.manage(&a, &id, 1, "unshare").unwrap();
    let pending = store.pending_cloud().unwrap();
    store
        .cloud_ack(&id, pending[0]["request_id"].as_str().unwrap(), &unshared)
        .unwrap();
    let mut edit = request();
    edit.request_id = "after-unshare".into();
    edit.id = Some(id.clone());
    edit.expected_version = Some(2);
    store.remember_in_scope(&a, edit, true).unwrap();
    assert!(!store.read(&a, &id).unwrap().shared);
    assert!(store.pending_cloud().unwrap().is_empty());
    store.manage(&a, &id, 3, "share").unwrap();
    assert_eq!(store.pending_cloud().unwrap()[0]["expected_version"], 2);
}

#[test]
fn exact_duplicates_reuse_memory_and_ambiguous_corrections_require_review() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let a = actor();
    let saved = store.remember(&a, request()).unwrap();
    let mut duplicate = request();
    duplicate.request_id = "duplicate".into();
    assert_eq!(store.remember(&a, duplicate).unwrap().id, saved.id);
    let mut changed = request();
    changed.request_id = "ambiguous".into();
    changed.body = "이제 영어로 설명한다.".into();
    let proposed = store.remember(&a, changed).unwrap();
    assert_eq!(proposed.status, "proposed");
    assert_ne!(proposed.id, saved.id);
    assert!(store.read(&a, &saved.id).unwrap().body.contains("한국어"));
    let path = "Knowledge/decisions/review.md";
    store.attach_decision(&a.client, "ambiguous", path).unwrap();
    store.check_pending_version(path).unwrap();
    let mut explicit = request();
    explicit.request_id = "explicit".into();
    explicit.id = Some(saved.id);
    explicit.expected_version = Some(1);
    explicit.body = "newer correction".into();
    store.remember(&a, explicit).unwrap();
    assert!(store.check_pending_version(path).is_err());
}
