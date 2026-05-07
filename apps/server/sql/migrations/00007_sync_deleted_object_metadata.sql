ALTER TABLE kuku.sync_objects
  DROP CONSTRAINT chk_kuku_sync_objects_upload_metadata;

ALTER TABLE kuku.sync_objects
  ADD CONSTRAINT chk_kuku_sync_objects_upload_metadata
  CHECK (
    upload_state IN ('reserved', 'deleted')
    OR (ciphertext_sha256 <> '' AND size_bytes > 0)
  );
