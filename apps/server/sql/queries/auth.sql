-- name: CreateUser :one
INSERT INTO auth.users (email, name, email_confirmed_at)
VALUES ($1, $2, $3)
RETURNING *;

-- name: GetUserByID :one
SELECT * FROM auth.users
WHERE id = $1 AND deleted_at IS NULL;

-- name: GetUserByEmail :one
SELECT * FROM auth.users
WHERE email = $1 AND deleted_at IS NULL;

-- name: UpdateUserName :one
UPDATE auth.users
SET name = $2, updated_at = now()
WHERE id = $1 AND deleted_at IS NULL
RETURNING *;

-- name: UpdateUserLastSignIn :exec
UPDATE auth.users
SET last_sign_in_at = now(), updated_at = now()
WHERE id = $1 AND deleted_at IS NULL;

-- name: SoftDeleteUser :exec
UPDATE auth.users
SET deleted_at = now(), updated_at = now()
WHERE id = $1 AND deleted_at IS NULL;

-- name: CreateIdentity :one
INSERT INTO auth.identities (user_id, provider, provider_id, identity_data, email, last_sign_in_at)
VALUES ($1, $2, $3, $4, $5, now())
RETURNING *;

-- name: GetIdentityByProviderID :one
SELECT * FROM auth.identities
WHERE provider = $1 AND provider_id = $2;

-- name: UpdateIdentityLastSignIn :exec
UPDATE auth.identities
SET last_sign_in_at = now(), identity_data = $3, email = $4, updated_at = now()
WHERE provider = $1 AND provider_id = $2;

-- name: CreateSession :one
INSERT INTO auth.sessions (user_id, not_after, user_agent, ip_address)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: GetValidSession :one
SELECT * FROM auth.sessions
WHERE id = $1
  AND revoked_at IS NULL
  AND not_after > now()
  AND refreshed_at > now() - sqlc.arg('inactivity_timeout')::interval;

-- name: UpdateSessionRefreshedAt :exec
UPDATE auth.sessions
SET refreshed_at = now(), updated_at = now()
WHERE id = $1 AND revoked_at IS NULL;

-- name: RevokeSession :exec
UPDATE auth.sessions
SET revoked_at = now(), updated_at = now()
WHERE id = $1 AND revoked_at IS NULL;

-- name: RevokeAllUserSessions :exec
UPDATE auth.sessions
SET revoked_at = now(), updated_at = now()
WHERE user_id = $1 AND revoked_at IS NULL;

-- name: CreateRefreshToken :one
INSERT INTO auth.refresh_tokens (token_hash, session_id, user_id, expires_at)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: ConsumeRefreshTokenByHash :one
UPDATE auth.refresh_tokens AS rt
SET revoked_at = now(), updated_at = now()
FROM auth.sessions AS s
WHERE rt.session_id = s.id
  AND rt.token_hash = $1
  AND rt.revoked_at IS NULL
  AND rt.expires_at > now()
  AND s.revoked_at IS NULL
  AND s.not_after > now()
  AND s.refreshed_at > now() - sqlc.arg('inactivity_timeout')::interval
RETURNING rt.*;

-- name: RevokeRefreshToken :exec
UPDATE auth.refresh_tokens
SET revoked_at = now(), updated_at = now()
WHERE id = $1 AND revoked_at IS NULL;

-- name: RevokeSessionRefreshTokens :exec
UPDATE auth.refresh_tokens
SET revoked_at = now(), updated_at = now()
WHERE session_id = $1 AND revoked_at IS NULL;

-- name: RevokeAllUserRefreshTokens :exec
UPDATE auth.refresh_tokens
SET revoked_at = now(), updated_at = now()
WHERE user_id = $1 AND revoked_at IS NULL;

-- name: CreateFlowState :one
INSERT INTO auth.flow_state (auth_code, provider_type, authentication_method, email, user_id, redirect_uri, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: GetFlowStateByCode :one
SELECT * FROM auth.flow_state
WHERE auth_code = $1 AND expires_at > now();

-- name: DeleteFlowState :exec
DELETE FROM auth.flow_state
WHERE id = $1;

-- name: CreateOneTimeToken :one
INSERT INTO auth.one_time_tokens (user_id, email, token_type, token_hash, expires_at)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: ConsumeOneTimeToken :one
-- Atomic lookup-and-invalidate. The previous separate SELECT + UPDATE pair
-- allowed two concurrent requests with the same code to both pass the
-- IS NULL guard before either UPDATE landed; this single UPDATE is
-- serialized by the row lock, and the RETURNING clause means only the
-- winner gets a non-empty result. A second caller (or a stale/used token)
-- gets pgx.ErrNoRows.
UPDATE auth.one_time_tokens
SET used_at = now()
WHERE token_hash = $1
  AND used_at IS NULL
  AND expires_at > now()
RETURNING *;

-- name: InvalidateOneTimeTokensByEmail :exec
UPDATE auth.one_time_tokens
SET used_at = now()
WHERE email = $1 AND token_type = $2 AND used_at IS NULL;

-- name: CreateAuthEvent :exec
INSERT INTO audit_log.auth_events (actor_id, actor_email, action, payload, ip_address, user_agent)
VALUES ($1, $2, $3, $4, $5, $6);
