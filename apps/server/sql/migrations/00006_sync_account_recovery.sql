CREATE TYPE kuku.sync_account_key_recipient_type AS ENUM (
  'recovery_phrase',
  'device'
);

CREATE TABLE kuku.sync_account_keys (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  account_key_id TEXT NOT NULL,
  crypto_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, account_key_id),
  CONSTRAINT chk_kuku_sync_account_keys_account_key_id_present CHECK (account_key_id <> ''),
  CONSTRAINT chk_kuku_sync_account_keys_crypto_version_present CHECK (crypto_version <> '')
);

CREATE UNIQUE INDEX uq_kuku_sync_account_keys_account_key_id
  ON kuku.sync_account_keys(account_key_id);

CREATE TABLE kuku.sync_account_key_envelopes (
  user_id UUID NOT NULL,
  account_key_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  recipient_type kuku.sync_account_key_recipient_type NOT NULL,
  key_version BIGINT NOT NULL,
  kdf_params JSONB,
  encrypted_envelope BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, account_key_id, envelope_id),
  FOREIGN KEY (user_id, account_key_id)
    REFERENCES kuku.sync_account_keys(user_id, account_key_id)
    ON DELETE CASCADE,
  CONSTRAINT chk_kuku_sync_account_key_envelopes_key_version_positive CHECK (key_version > 0),
  CONSTRAINT chk_kuku_sync_account_key_envelopes_encrypted_present CHECK (octet_length(encrypted_envelope) > 0),
  CONSTRAINT chk_kuku_sync_account_key_envelopes_recipient_supported
    CHECK (recipient_type IN ('recovery_phrase', 'device'))
);

ALTER TABLE kuku.sync_workspaces
  ADD COLUMN encrypted_metadata BYTEA,
  ADD COLUMN metadata_version BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN encrypted_workspace_key BYTEA,
  ADD COLUMN workspace_key_version BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT chk_kuku_sync_workspaces_metadata_version_non_negative CHECK (metadata_version >= 0),
  ADD CONSTRAINT chk_kuku_sync_workspaces_workspace_key_version_non_negative CHECK (workspace_key_version >= 0);

ALTER TABLE kuku.sync_devices
  ADD COLUMN metadata_version BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT chk_kuku_sync_devices_metadata_version_non_negative CHECK (metadata_version >= 0);

CREATE TRIGGER trg_kuku_sync_account_keys_updated_at
  BEFORE UPDATE ON kuku.sync_account_keys
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_kuku_sync_account_key_envelopes_updated_at
  BEFORE UPDATE ON kuku.sync_account_key_envelopes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
