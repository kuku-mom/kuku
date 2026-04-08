CREATE TYPE kuku.plan AS ENUM ('FREE', 'PRO', 'ULTRA');
CREATE TYPE kuku.subscription_status AS ENUM ('ACTIVE', 'CANCELED');

CREATE TABLE kuku.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan kuku.plan NOT NULL DEFAULT 'FREE',
  status kuku.subscription_status NOT NULL DEFAULT 'ACTIVE',
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_period_end TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_kuku_subscriptions_user_id UNIQUE(user_id)
);

CREATE INDEX idx_kuku_subscriptions_user_id ON kuku.subscriptions(user_id);

CREATE TABLE kuku.usage_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  ai_requests INTEGER NOT NULL DEFAULT 0,
  tokens_k REAL NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_kuku_usage_stats_user_date UNIQUE(user_id, date)
);

CREATE INDEX idx_kuku_usage_stats_user_date ON kuku.usage_stats(user_id, date DESC);

CREATE OR REPLACE FUNCTION kuku.create_user_subscription()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO kuku.subscriptions (user_id, plan, status)
  VALUES (NEW.id, 'FREE', 'ACTIVE')
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_create_user_subscription
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION kuku.create_user_subscription();
