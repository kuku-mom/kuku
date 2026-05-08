-- name: CreateSyncWorkspace :one
INSERT INTO kuku.sync_workspaces (owner_user_id, crypto_version)
VALUES ($1, $2)
RETURNING *;

-- name: GetSyncAccountKeyByUser :one
SELECT * FROM kuku.sync_account_keys
WHERE user_id = $1;

-- name: CreateSyncAccountKey :one
INSERT INTO kuku.sync_account_keys (
  user_id,
  account_key_id,
  crypto_version
)
VALUES ($1, $2, $3)
RETURNING *;

-- name: UpsertSyncAccountKeyEnvelope :one
INSERT INTO kuku.sync_account_key_envelopes (
  user_id,
  account_key_id,
  envelope_id,
  recipient_type,
  key_version,
  kdf_params,
  encrypted_envelope
)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (user_id, account_key_id, envelope_id)
DO UPDATE SET
  recipient_type = EXCLUDED.recipient_type,
  key_version = EXCLUDED.key_version,
  kdf_params = EXCLUDED.kdf_params,
  encrypted_envelope = EXCLUDED.encrypted_envelope,
  updated_at = now()
RETURNING *;

-- name: ListSyncAccountKeyEnvelopes :many
SELECT * FROM kuku.sync_account_key_envelopes
WHERE user_id = $1
ORDER BY key_version ASC, envelope_id ASC;

-- name: GetSyncWorkspaceByIDAndOwner :one
SELECT * FROM kuku.sync_workspaces
WHERE id = $1
  AND owner_user_id = $2
  AND deleted_at IS NULL;

-- name: ListSyncWorkspacesByOwner :many
SELECT * FROM kuku.sync_workspaces
WHERE owner_user_id = $1
  AND deleted_at IS NULL
ORDER BY updated_at DESC, created_at DESC, id ASC;

-- name: GetSyncWorkspaceForUpdate :one
SELECT * FROM kuku.sync_workspaces
WHERE id = $1
  AND owner_user_id = $2
  AND deleted_at IS NULL
FOR UPDATE;

-- name: UpdateSyncWorkspaceMetadata :one
UPDATE kuku.sync_workspaces
SET encrypted_metadata = $3,
    metadata_version = $4,
    updated_at = now()
WHERE id = $1
  AND owner_user_id = $2
  AND metadata_version = $5
  AND deleted_at IS NULL
RETURNING *;

-- name: UpdateSyncWorkspaceKey :one
UPDATE kuku.sync_workspaces
SET encrypted_workspace_key = $3,
    workspace_key_version = $4,
    updated_at = now()
WHERE id = $1
  AND owner_user_id = $2
  AND workspace_key_version = $5
  AND deleted_at IS NULL
RETURNING *;

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

-- name: SoftDeleteSyncWorkspacesByOwner :exec
UPDATE kuku.sync_workspaces
SET deleted_at = now(), updated_at = now()
WHERE owner_user_id = $1
  AND deleted_at IS NULL;

-- name: HardDeleteSyncWorkspace :exec
DELETE FROM kuku.sync_workspaces
WHERE id = $1
  AND deleted_at IS NOT NULL;

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

-- name: UpdateSyncDeviceMetadata :one
UPDATE kuku.sync_devices
SET encrypted_device_name = $4,
    metadata_version = $5,
    updated_at = now()
WHERE workspace_id = $1
  AND id = $2
  AND user_id = $3
  AND metadata_version = $6
  AND revoked_at IS NULL
RETURNING *;

-- name: RevokeSyncDevicesByOwner :exec
UPDATE kuku.sync_devices AS d
SET revoked_at = now(), updated_at = now()
FROM kuku.sync_workspaces AS w
WHERE d.workspace_id = w.id
  AND w.owner_user_id = $1
  AND d.revoked_at IS NULL;

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

-- name: ReleaseSyncUsagePendingBytes :exec
UPDATE kuku.sync_usage_workspaces
SET pending_upload_bytes = pending_upload_bytes - $2,
    updated_at = now()
WHERE workspace_id = $1;

-- name: ReleaseSyncUsageAccountPendingBytes :exec
UPDATE kuku.sync_usage_accounts
SET pending_upload_bytes = pending_upload_bytes - $2,
    updated_at = now()
WHERE user_id = $1;

-- name: ResetSyncUsageWorkspacesByOwner :exec
UPDATE kuku.sync_usage_workspaces AS suw
SET storage_bytes = 0,
    object_count = 0,
    pending_upload_bytes = 0,
    updated_at = now()
FROM kuku.sync_workspaces AS w
WHERE suw.workspace_id = w.id
  AND w.owner_user_id = $1;

-- name: ResetSyncUsageAccount :exec
UPDATE kuku.sync_usage_accounts
SET workspace_count = 0,
    total_storage_bytes = 0,
    pending_upload_bytes = 0,
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

-- name: RecalculateSyncUsageWorkspace :one
WITH usage AS (
  SELECT
    COALESCE(SUM(size_bytes) FILTER (
      WHERE upload_state = 'available'
        AND deleted_at IS NULL
    ), 0)::BIGINT AS storage_bytes,
    COUNT(*) FILTER (
      WHERE upload_state = 'available'
        AND deleted_at IS NULL
    )::BIGINT AS object_count,
    COALESCE(SUM(size_bytes) FILTER (
      WHERE upload_state = 'pending'
        AND deleted_at IS NULL
    ), 0)::BIGINT AS pending_upload_bytes
  FROM kuku.sync_objects
  WHERE workspace_id = $1
)
UPDATE kuku.sync_usage_workspaces AS suw
SET storage_bytes = usage.storage_bytes,
    object_count = usage.object_count,
    pending_upload_bytes = usage.pending_upload_bytes,
    updated_at = now()
FROM usage
WHERE suw.workspace_id = $1
RETURNING suw.*;

-- name: RecalculateSyncUsageAccount :one
WITH usage AS (
  SELECT
    COUNT(*) FILTER (
      WHERE w.deleted_at IS NULL
    )::INTEGER AS workspace_count,
    COALESCE(SUM(uw.storage_bytes) FILTER (
      WHERE w.deleted_at IS NULL
    ), 0)::BIGINT AS total_storage_bytes,
    COALESCE(SUM(uw.pending_upload_bytes) FILTER (
      WHERE w.deleted_at IS NULL
    ), 0)::BIGINT AS pending_upload_bytes
  FROM kuku.sync_workspaces w
  LEFT JOIN kuku.sync_usage_workspaces uw
    ON uw.workspace_id = w.id
  WHERE w.owner_user_id = $1
)
UPDATE kuku.sync_usage_accounts AS sua
SET workspace_count = usage.workspace_count,
    total_storage_bytes = usage.total_storage_bytes,
    pending_upload_bytes = usage.pending_upload_bytes,
    updated_at = now()
FROM usage
WHERE sua.user_id = $1
RETURNING sua.*;

-- name: ListSyncCommitsAfterServerSeq :many
SELECT * FROM kuku.sync_commits
WHERE workspace_id = $1
  AND server_seq > $2
ORDER BY server_seq ASC
LIMIT $3;

-- name: ListSyncCommitsByWorkspaceDesc :many
SELECT * FROM kuku.sync_commits
WHERE workspace_id = $1
ORDER BY server_seq DESC;

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

-- name: ListSyncCommitObjectsByWorkspace :many
SELECT * FROM kuku.sync_commit_objects
WHERE workspace_id = $1
ORDER BY commit_id ASC, object_id ASC;

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

-- name: GetLatestSyncCheckpointCommit :one
SELECT * FROM kuku.sync_commits
WHERE workspace_id = $1
  AND commit_kind = 'checkpoint'
ORDER BY server_seq DESC
LIMIT 1;

-- name: ListExpiredOrphanSyncObjectsForUpdate :many
SELECT * FROM kuku.sync_objects
WHERE workspace_id = $1
  AND upload_state IN ('reserved', 'pending', 'failed')
  AND deleted_at IS NULL
  AND expires_at IS NOT NULL
  AND expires_at <= $2
ORDER BY expires_at ASC, object_id ASC
LIMIT $3
FOR UPDATE SKIP LOCKED;

-- name: ListDeletedSyncWorkspacesForCleanup :many
SELECT * FROM kuku.sync_workspaces
WHERE deleted_at IS NOT NULL
  AND deleted_at <= $1
ORDER BY deleted_at ASC, id ASC
LIMIT $2
FOR UPDATE SKIP LOCKED;

-- name: ListAllSyncObjectsByWorkspaceForUpdate :many
SELECT * FROM kuku.sync_objects
WHERE workspace_id = $1
ORDER BY object_id ASC
FOR UPDATE;

-- name: MarkSyncObjectDeleted :one
UPDATE kuku.sync_objects
SET upload_state = 'deleted',
    expires_at = NULL,
    deleted_at = now(),
    updated_at = now()
WHERE workspace_id = $1
  AND object_id = $2
  AND deleted_at IS NULL
RETURNING *;

-- name: MarkSyncObjectsDeletedByOwner :exec
UPDATE kuku.sync_objects AS o
SET upload_state = 'deleted',
    expires_at = NULL,
    deleted_at = now(),
    updated_at = now()
FROM kuku.sync_workspaces AS w
WHERE o.workspace_id = w.id
  AND w.owner_user_id = $1
  AND o.deleted_at IS NULL;
