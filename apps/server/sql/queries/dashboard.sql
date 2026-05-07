-- name: GetSubscriptionByUserID :one
SELECT * FROM kuku.subscriptions
WHERE user_id = $1;

-- name: GetSubscriptionByUserIDForUpdate :one
SELECT * FROM kuku.subscriptions
WHERE user_id = $1
FOR UPDATE;

-- name: EnsureSubscriptionExists :one
INSERT INTO kuku.subscriptions (user_id, plan, status)
VALUES ($1, 'FREE', 'ACTIVE')
ON CONFLICT (user_id) DO UPDATE SET updated_at = now()
RETURNING *;

-- name: UpdateSubscriptionPeriod :one
UPDATE kuku.subscriptions
SET current_period_start = sqlc.arg(current_period_start),
    current_period_end = sqlc.arg(current_period_end)
WHERE user_id = sqlc.arg(user_id)
RETURNING *;

-- name: GetCurrentPeriodUsage :one
SELECT
  COALESCE(SUM(ai_requests), 0)::INTEGER AS total_ai_requests,
  COALESCE(SUM(tokens_k), 0)::REAL AS total_tokens_k
FROM kuku.usage_stats
WHERE user_id = $1
  AND date >= $2
  AND date <= $3;

-- name: IncrementDailyAIRequests :exec
INSERT INTO kuku.usage_stats (user_id, date, ai_requests)
VALUES ($1, $2, $3)
ON CONFLICT (user_id, date)
DO UPDATE SET ai_requests = kuku.usage_stats.ai_requests + EXCLUDED.ai_requests;

-- name: IncrementDailyAITokens :exec
INSERT INTO kuku.usage_stats (user_id, date, tokens_k)
VALUES (sqlc.arg(user_id), sqlc.arg(usage_date), (sqlc.arg(total_tokens)::BIGINT::NUMERIC / 1000.0))
ON CONFLICT (user_id, date)
DO UPDATE SET tokens_k = kuku.usage_stats.tokens_k + EXCLUDED.tokens_k;

-- name: GetUsageStatsByUserAndDateRange :many
-- Explicit column list so the tokens_k cast pins sqlc's generated Go type
-- (float32) regardless of the storage type. Storage is NUMERIC so SUM
-- aggregates are exact; the cast here is lossless for display (REAL has
-- more than enough precision for per-day token counts).
SELECT id, user_id, date, ai_requests, tokens_k::REAL AS tokens_k, created_at, updated_at
FROM kuku.usage_stats
WHERE user_id = $1
  AND date >= $2
  AND date <= $3
ORDER BY date ASC;
