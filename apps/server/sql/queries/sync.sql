-- name: CreateSyncWorkspace :one
INSERT INTO kuku.sync_workspaces (owner_user_id, crypto_version)
VALUES ($1, $2)
RETURNING *;

-- name: GetSyncWorkspaceByIDAndOwner :one
SELECT * FROM kuku.sync_workspaces
WHERE id = $1
  AND owner_user_id = $2
  AND deleted_at IS NULL;

-- name: GetSyncWorkspaceForUpdate :one
SELECT * FROM kuku.sync_workspaces
WHERE id = $1
  AND owner_user_id = $2
  AND deleted_at IS NULL
FOR UPDATE;

-- name: CountActiveSyncWorkspacesByOwner :one
SELECT count(*)::INTEGER FROM kuku.sync_workspaces
WHERE owner_user_id = $1
  AND deleted_at IS NULL;

-- name: SoftDeleteSyncWorkspace :exec
UPDATE kuku.sync_workspaces
SET deleted_at = now(), updated_at = now()
WHERE id = $1
  AND owner_user_id = $2
  AND deleted_at IS NULL;

-- name: EnsureSyncUsageAccount :one
INSERT INTO kuku.sync_usage_accounts (user_id)
VALUES ($1)
ON CONFLICT (user_id) DO UPDATE SET updated_at = now()
RETURNING *;

-- name: GetSyncUsageAccountForUpdate :one
SELECT * FROM kuku.sync_usage_accounts
WHERE user_id = $1
FOR UPDATE;

-- name: IncrementSyncUsageWorkspaceCount :exec
UPDATE kuku.sync_usage_accounts
SET workspace_count = workspace_count + $2,
    updated_at = now()
WHERE user_id = $1;

-- name: CreateSyncUsageWorkspace :one
INSERT INTO kuku.sync_usage_workspaces (workspace_id)
VALUES ($1)
RETURNING *;

-- name: GetSyncUsageWorkspaceForUpdate :one
SELECT * FROM kuku.sync_usage_workspaces
WHERE workspace_id = $1
FOR UPDATE;

-- name: CreateSyncDevice :one
INSERT INTO kuku.sync_devices (
  workspace_id,
  user_id,
  signing_public_key,
  encryption_public_key,
  encrypted_device_name,
  last_seen_at
)
VALUES ($1, $2, $3, $4, $5, now())
RETURNING *;

-- name: GetActiveSyncDevice :one
SELECT * FROM kuku.sync_devices
WHERE workspace_id = $1
  AND id = $2
  AND user_id = $3
  AND revoked_at IS NULL;

-- name: GetActiveSyncDeviceForUpdate :one
SELECT * FROM kuku.sync_devices
WHERE workspace_id = $1
  AND id = $2
  AND user_id = $3
  AND revoked_at IS NULL
FOR UPDATE;

-- name: TouchSyncDeviceLastSeen :exec
UPDATE kuku.sync_devices
SET last_seen_at = now(), updated_at = now()
WHERE workspace_id = $1
  AND id = $2
  AND user_id = $3
  AND revoked_at IS NULL;

-- name: UpsertSyncKeyEnvelope :one
INSERT INTO kuku.sync_key_envelopes (
  workspace_id,
  envelope_id,
  recipient_type,
  recipient_device_id,
  key_version,
  kdf_params,
  encrypted_envelope,
  created_by_device_id
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (workspace_id, envelope_id)
DO UPDATE SET
  recipient_type = EXCLUDED.recipient_type,
  recipient_device_id = EXCLUDED.recipient_device_id,
  key_version = EXCLUDED.key_version,
  kdf_params = EXCLUDED.kdf_params,
  encrypted_envelope = EXCLUDED.encrypted_envelope,
  created_by_device_id = EXCLUDED.created_by_device_id,
  updated_at = now()
RETURNING *;

-- name: ListSyncKeyEnvelopes :many
SELECT * FROM kuku.sync_key_envelopes
WHERE workspace_id = $1
ORDER BY key_version ASC, envelope_id ASC;

-- name: CreateReservedSyncObject :one
INSERT INTO kuku.sync_objects (
  workspace_id,
  object_id,
  object_kind,
  storage_provider,
  storage_key,
  upload_state,
  created_by_device_id,
  expires_at
)
VALUES ($1, $2, $3, $4, $5, 'reserved', $6, $7)
RETURNING *;

-- name: GetSyncObject :one
SELECT * FROM kuku.sync_objects
WHERE workspace_id = $1
  AND object_id = $2
  AND deleted_at IS NULL;

-- name: GetSyncObjectForUpdate :one
SELECT * FROM kuku.sync_objects
WHERE workspace_id = $1
  AND object_id = $2
  AND deleted_at IS NULL
FOR UPDATE;

-- name: ListSyncObjectsByIDs :many
SELECT * FROM kuku.sync_objects
WHERE workspace_id = $1
  AND object_id = ANY($2::TEXT[])
  AND deleted_at IS NULL
ORDER BY object_id ASC;

-- name: MarkSyncObjectPending :one
UPDATE kuku.sync_objects
SET upload_state = 'pending',
    ciphertext_sha256 = $3,
    size_bytes = $4,
    expires_at = $5,
    error_reason = NULL,
    updated_at = now()
WHERE workspace_id = $1
  AND object_id = $2
  AND upload_state IN ('reserved', 'pending')
  AND deleted_at IS NULL
RETURNING *;

-- name: MarkSyncObjectAvailable :one
UPDATE kuku.sync_objects
SET upload_state = 'available',
    ciphertext_sha256 = $3,
    size_bytes = $4,
    available_at = now(),
    expires_at = NULL,
    error_reason = NULL,
    updated_at = now()
WHERE workspace_id = $1
  AND object_id = $2
  AND upload_state IN ('reserved', 'pending', 'available')
  AND deleted_at IS NULL
RETURNING *;

-- name: MarkSyncObjectFailed :one
UPDATE kuku.sync_objects
SET upload_state = 'failed',
    error_reason = $3,
    updated_at = now()
WHERE workspace_id = $1
  AND object_id = $2
  AND deleted_at IS NULL
RETURNING *;

-- name: AddSyncUsagePendingBytes :exec
UPDATE kuku.sync_usage_workspaces
SET pending_upload_bytes = pending_upload_bytes + $2,
    updated_at = now()
WHERE workspace_id = $1;

-- name: AddSyncUsageAccountPendingBytes :exec
UPDATE kuku.sync_usage_accounts
SET pending_upload_bytes = pending_upload_bytes + $2,
    updated_at = now()
WHERE user_id = $1;

-- name: CompleteSyncUsageObjectBytes :exec
UPDATE kuku.sync_usage_workspaces
SET pending_upload_bytes = pending_upload_bytes - $2,
    storage_bytes = storage_bytes + $2,
    object_count = object_count + 1,
    updated_at = now()
WHERE workspace_id = $1;

-- name: CompleteSyncUsageAccountObjectBytes :exec
UPDATE kuku.sync_usage_accounts
SET pending_upload_bytes = pending_upload_bytes - $2,
    total_storage_bytes = total_storage_bytes + $2,
    updated_at = now()
WHERE user_id = $1;

-- name: AddSyncUsageAvailableObjectBytes :exec
UPDATE kuku.sync_usage_workspaces
SET storage_bytes = storage_bytes + $2,
    object_count = object_count + 1,
    updated_at = now()
WHERE workspace_id = $1;

-- name: AddSyncUsageAccountAvailableObjectBytes :exec
UPDATE kuku.sync_usage_accounts
SET total_storage_bytes = total_storage_bytes + $2,
    updated_at = now()
WHERE user_id = $1;

-- name: ListSyncCommitsAfterServerSeq :many
SELECT * FROM kuku.sync_commits
WHERE workspace_id = $1
  AND server_seq > $2
ORDER BY server_seq ASC
LIMIT $3;

-- name: GetSyncCommit :one
SELECT * FROM kuku.sync_commits
WHERE workspace_id = $1
  AND commit_id = $2;

-- name: CreateSyncCommit :one
INSERT INTO kuku.sync_commits (
  workspace_id,
  commit_id,
  commit_kind,
  expected_head_commit_id,
  author_device_id,
  device_seq,
  parent_commit_ids,
  body_object_id,
  body_ciphertext_sha256,
  body_size_bytes,
  referenced_object_ids,
  signature
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
RETURNING *;

-- name: CreateSyncCommitObject :exec
INSERT INTO kuku.sync_commit_objects (workspace_id, commit_id, object_id, object_role)
VALUES ($1, $2, $3, $4)
ON CONFLICT (workspace_id, commit_id, object_id) DO NOTHING;

-- name: UpdateSyncWorkspaceHead :one
UPDATE kuku.sync_workspaces
SET current_head_commit_id = $3,
    head_version = head_version + 1,
    updated_at = now()
WHERE id = $1
  AND owner_user_id = $2
  AND deleted_at IS NULL
RETURNING *;

-- name: UpdateSyncDeviceSequence :exec
UPDATE kuku.sync_devices
SET last_device_seq = $4,
    last_seen_at = now(),
    updated_at = now()
WHERE workspace_id = $1
  AND id = $2
  AND user_id = $3
  AND revoked_at IS NULL;

-- name: UpsertSyncDeviceCursor :exec
INSERT INTO kuku.sync_device_cursors (
  workspace_id,
  device_id,
  last_seen_commit_id,
  last_seen_checkpoint_commit_id,
  updated_at
)
VALUES ($1, $2, $3, $4, now())
ON CONFLICT (workspace_id, device_id)
DO UPDATE SET
  last_seen_commit_id = EXCLUDED.last_seen_commit_id,
  last_seen_checkpoint_commit_id = COALESCE(EXCLUDED.last_seen_checkpoint_commit_id, kuku.sync_device_cursors.last_seen_checkpoint_commit_id),
  updated_at = now();

-- name: GetLatestSyncCheckpointCommitID :one
SELECT commit_id FROM kuku.sync_commits
WHERE workspace_id = $1
  AND commit_kind = 'checkpoint'
ORDER BY server_seq DESC
LIMIT 1;
