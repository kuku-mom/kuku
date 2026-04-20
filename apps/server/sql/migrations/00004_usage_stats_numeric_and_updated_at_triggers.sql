-- Move tokens_k off REAL so accumulated usage sums are not silently rounded.
-- NUMERIC(14, 3) covers ~99 billion thousand-tokens with 3 decimal places of
-- precision — far above anything we could serve on a single-node setup, but
-- exact so partial-credit arithmetic (rounding down 0.500 -> 0 etc.) cannot
-- drift. Casting from REAL rewrites the table; safe to do while the table
-- is small, cheap to revisit once traffic grows.
ALTER TABLE kuku.usage_stats
  ALTER COLUMN tokens_k TYPE NUMERIC(14, 3) USING tokens_k::NUMERIC(14, 3);

-- Enforce updated_at at the schema level so any future INSERT/UPDATE path —
-- sqlc-generated queries today, ad-hoc ones tomorrow — can't forget to set
-- it. The trigger only fires on UPDATE (rows are created with DEFAULT
-- now()), only touches the column when it was not explicitly set, and uses
-- IS DISTINCT FROM so no-op updates (writing the same row back) don't bump
-- the timestamp unnecessarily.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_auth_users_updated_at
  BEFORE UPDATE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_auth_identities_updated_at
  BEFORE UPDATE ON auth.identities
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_auth_sessions_updated_at
  BEFORE UPDATE ON auth.sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_auth_refresh_tokens_updated_at
  BEFORE UPDATE ON auth.refresh_tokens
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_auth_flow_state_updated_at
  BEFORE UPDATE ON auth.flow_state
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_kuku_subscriptions_updated_at
  BEFORE UPDATE ON kuku.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_kuku_usage_stats_updated_at
  BEFORE UPDATE ON kuku.usage_stats
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
