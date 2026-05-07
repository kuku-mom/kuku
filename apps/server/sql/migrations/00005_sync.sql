CREATE TYPE kuku.sync_object_kind AS ENUM (
  'commit_body',
  'content_pack',
  'checkpoint_pack',
  'large_object'
);

CREATE TYPE kuku.sync_commit_kind AS ENUM (
  'incremental',
  'merge',
  'checkpoint'
);

CREATE TYPE kuku.sync_object_state AS ENUM (
  'reserved',
  'pending',
  'available',
  'failed',
  'deleted'
);

CREATE TYPE kuku.sync_object_error_reason AS ENUM (
  'upload_expired',
  'checksum_mismatch',
  'size_mismatch',
  'storage_provider_error',
  'quota_exceeded',
  'canceled'
);

CREATE TYPE kuku.sync_storage_provider AS ENUM (
  'local',
  's3_compatible'
);

CREATE TYPE kuku.sync_key_recipient_type AS ENUM (
  'passphrase',
  'device'
);

CREATE TYPE kuku.sync_commit_object_role AS ENUM (
  'body',
  'content_pack',
  'checkpoint_pack',
  'large_object'
);

CREATE TABLE kuku.sync_workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  current_head_commit_id TEXT,
  head_version BIGINT NOT NULL DEFAULT 0,
  crypto_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_kuku_sync_workspaces_owner_user_id ON kuku.sync_workspaces(owner_user_id)
  WHERE deleted_at IS NULL;

CREATE TABLE kuku.sync_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES kuku.sync_workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  signing_public_key BYTEA NOT NULL,
  encryption_public_key BYTEA,
  encrypted_device_name BYTEA,
  last_device_seq BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT uq_kuku_sync_devices_workspace_id_id UNIQUE(workspace_id, id)
);

CREATE INDEX idx_kuku_sync_devices_workspace_id ON kuku.sync_devices(workspace_id)
  WHERE revoked_at IS NULL;

CREATE INDEX idx_kuku_sync_devices_user_id ON kuku.sync_devices(user_id)
  WHERE revoked_at IS NULL;

CREATE TABLE kuku.sync_device_cursors (
  workspace_id UUID NOT NULL,
  device_id UUID NOT NULL,
  last_seen_commit_id TEXT,
  last_seen_checkpoint_commit_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, device_id),
  FOREIGN KEY (workspace_id, device_id)
    REFERENCES kuku.sync_devices(workspace_id, id)
    ON DELETE CASCADE
);

CREATE TABLE kuku.sync_key_envelopes (
  workspace_id UUID NOT NULL REFERENCES kuku.sync_workspaces(id) ON DELETE CASCADE,
  envelope_id TEXT NOT NULL,
  recipient_type kuku.sync_key_recipient_type NOT NULL,
  recipient_device_id UUID,
  key_version BIGINT NOT NULL,
  kdf_params JSONB,
  encrypted_envelope BYTEA NOT NULL,
  created_by_device_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, envelope_id),
  FOREIGN KEY (workspace_id, recipient_device_id)
    REFERENCES kuku.sync_devices(workspace_id, id)
    ON DELETE SET NULL,
  FOREIGN KEY (workspace_id, created_by_device_id)
    REFERENCES kuku.sync_devices(workspace_id, id)
    ON DELETE SET NULL,
  CONSTRAINT chk_kuku_sync_key_envelopes_recipient_device
    CHECK (
      (recipient_type = 'device' AND recipient_device_id IS NOT NULL)
      OR (recipient_type = 'passphrase')
    )
);

CREATE TABLE kuku.sync_objects (
  workspace_id UUID NOT NULL REFERENCES kuku.sync_workspaces(id) ON DELETE CASCADE,
  object_id TEXT NOT NULL,
  object_kind kuku.sync_object_kind NOT NULL,
  storage_provider kuku.sync_storage_provider NOT NULL,
  storage_key TEXT NOT NULL,
  ciphertext_sha256 TEXT NOT NULL DEFAULT '',
  size_bytes BIGINT NOT NULL DEFAULT 0,
  upload_state kuku.sync_object_state NOT NULL,
  error_reason kuku.sync_object_error_reason,
  created_by_device_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  available_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, object_id),
  FOREIGN KEY (workspace_id, created_by_device_id)
    REFERENCES kuku.sync_devices(workspace_id, id)
    ON DELETE SET NULL,
  CONSTRAINT uq_kuku_sync_objects_storage_key UNIQUE(storage_key),
  CONSTRAINT chk_kuku_sync_objects_size_non_negative CHECK (size_bytes >= 0),
  CONSTRAINT chk_kuku_sync_objects_upload_metadata
    CHECK (
      upload_state = 'reserved'
      OR (ciphertext_sha256 <> '' AND size_bytes > 0)
    )
);

CREATE INDEX idx_kuku_sync_objects_workspace_state ON kuku.sync_objects(workspace_id, upload_state);
CREATE INDEX idx_kuku_sync_objects_expires_at ON kuku.sync_objects(expires_at)
  WHERE upload_state IN ('reserved', 'pending');
CREATE INDEX idx_kuku_sync_objects_deleted_at ON kuku.sync_objects(deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE TABLE kuku.sync_commits (
  workspace_id UUID NOT NULL REFERENCES kuku.sync_workspaces(id) ON DELETE CASCADE,
  commit_id TEXT NOT NULL,
  commit_kind kuku.sync_commit_kind NOT NULL,
  author_device_id UUID NOT NULL,
  device_seq BIGINT NOT NULL,
  parent_commit_ids TEXT[] NOT NULL,
  body_object_id TEXT NOT NULL,
  body_ciphertext_sha256 TEXT NOT NULL,
  body_size_bytes BIGINT NOT NULL,
  referenced_object_ids TEXT[] NOT NULL,
  signature BYTEA NOT NULL,
  server_seq BIGINT GENERATED ALWAYS AS IDENTITY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, commit_id),
  UNIQUE (workspace_id, author_device_id, device_seq),
  UNIQUE (workspace_id, server_seq),
  FOREIGN KEY (workspace_id, author_device_id)
    REFERENCES kuku.sync_devices(workspace_id, id),
  FOREIGN KEY (workspace_id, body_object_id)
    REFERENCES kuku.sync_objects(workspace_id, object_id),
  CONSTRAINT chk_kuku_sync_commits_device_seq_positive CHECK (device_seq > 0),
  CONSTRAINT chk_kuku_sync_commits_body_size_positive CHECK (body_size_bytes > 0),
  CONSTRAINT chk_kuku_sync_commits_body_sha_present CHECK (body_ciphertext_sha256 <> '')
);

CREATE INDEX idx_kuku_sync_commits_workspace_server_seq ON kuku.sync_commits(workspace_id, server_seq);
CREATE INDEX idx_kuku_sync_commits_author_device ON kuku.sync_commits(workspace_id, author_device_id, device_seq);

CREATE TABLE kuku.sync_commit_objects (
  workspace_id UUID NOT NULL,
  commit_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_role kuku.sync_commit_object_role NOT NULL,
  PRIMARY KEY (workspace_id, commit_id, object_id),
  FOREIGN KEY (workspace_id, commit_id)
    REFERENCES kuku.sync_commits(workspace_id, commit_id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, object_id)
    REFERENCES kuku.sync_objects(workspace_id, object_id)
);

CREATE INDEX idx_kuku_sync_commit_objects_object ON kuku.sync_commit_objects(workspace_id, object_id);

CREATE TABLE kuku.sync_usage_accounts (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_count INTEGER NOT NULL DEFAULT 0,
  total_storage_bytes BIGINT NOT NULL DEFAULT 0,
  pending_upload_bytes BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_kuku_sync_usage_accounts_workspace_count_non_negative CHECK (workspace_count >= 0),
  CONSTRAINT chk_kuku_sync_usage_accounts_storage_non_negative CHECK (total_storage_bytes >= 0),
  CONSTRAINT chk_kuku_sync_usage_accounts_pending_non_negative CHECK (pending_upload_bytes >= 0)
);

CREATE TABLE kuku.sync_usage_workspaces (
  workspace_id UUID PRIMARY KEY REFERENCES kuku.sync_workspaces(id) ON DELETE CASCADE,
  storage_bytes BIGINT NOT NULL DEFAULT 0,
  object_count BIGINT NOT NULL DEFAULT 0,
  pending_upload_bytes BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_kuku_sync_usage_workspaces_storage_non_negative CHECK (storage_bytes >= 0),
  CONSTRAINT chk_kuku_sync_usage_workspaces_object_count_non_negative CHECK (object_count >= 0),
  CONSTRAINT chk_kuku_sync_usage_workspaces_pending_non_negative CHECK (pending_upload_bytes >= 0)
);

CREATE TRIGGER trg_kuku_sync_workspaces_updated_at
  BEFORE UPDATE ON kuku.sync_workspaces
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_kuku_sync_devices_updated_at
  BEFORE UPDATE ON kuku.sync_devices
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_kuku_sync_key_envelopes_updated_at
  BEFORE UPDATE ON kuku.sync_key_envelopes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_kuku_sync_objects_updated_at
  BEFORE UPDATE ON kuku.sync_objects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_kuku_sync_usage_accounts_updated_at
  BEFORE UPDATE ON kuku.sync_usage_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_kuku_sync_usage_workspaces_updated_at
  BEFORE UPDATE ON kuku.sync_usage_workspaces
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
