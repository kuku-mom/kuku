-- name: GetSubscriptionByUserID :one
SELECT * FROM kuku.subscriptions
WHERE user_id = $1;

-- name: EnsureSubscriptionExists :one
INSERT INTO kuku.subscriptions (user_id, plan, status)
VALUES ($1, 'FREE', 'ACTIVE')
ON CONFLICT (user_id) DO UPDATE SET updated_at = now()
RETURNING *;

-- name: GetCurrentPeriodUsage :one
SELECT
  COALESCE(SUM(ai_requests), 0)::INTEGER AS total_ai_requests,
  COALESCE(SUM(tokens_k), 0)::REAL AS total_tokens_k
FROM kuku.usage_stats
WHERE user_id = $1
  AND date >= $2
  AND date <= $3;

-- name: GetUsageStatsByUserAndDateRange :many
SELECT * FROM kuku.usage_stats
WHERE user_id = $1
  AND date >= $2
  AND date <= $3
ORDER BY date ASC;
