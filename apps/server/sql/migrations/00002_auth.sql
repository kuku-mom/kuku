CREATE TYPE auth.one_time_token_type AS ENUM ('email_auth', 'email_change', 'desktop_auth');

CREATE TYPE audit_log.auth_action AS ENUM (
  'login',
  'logout',
  'signup',
  'token_refreshed',
  'token_revoked',
  'user_modified',
  'user_deleted',
  'email_otp_requested',
  'email_otp_verified',
  'identity_linked',
  'identity_unlinked'
);

CREATE TABLE auth.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  email_confirmed_at TIMESTAMPTZ,
  last_sign_in_at TIMESTAMPTZ,
  raw_app_meta_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_user_meta_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_auth_users_email_active ON auth.users(email) WHERE deleted_at IS NULL;

CREATE TABLE auth.identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  identity_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  email TEXT,
  last_sign_in_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_auth_identities_provider_provider_id UNIQUE(provider, provider_id)
);

CREATE INDEX idx_auth_identities_user_id ON auth.identities(user_id);

CREATE TABLE auth.sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  not_after TIMESTAMPTZ NOT NULL,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  user_agent TEXT,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_auth_sessions_user_id ON auth.sessions(user_id);

CREATE TABLE auth.refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL,
  session_id UUID NOT NULL REFERENCES auth.sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_auth_refresh_tokens_active_hash ON auth.refresh_tokens(token_hash) WHERE revoked_at IS NULL;
CREATE INDEX idx_auth_refresh_tokens_session_id ON auth.refresh_tokens(session_id);

CREATE TABLE auth.flow_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_code TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  authentication_method TEXT NOT NULL,
  email TEXT,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  redirect_uri TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX idx_auth_flow_state_auth_code ON auth.flow_state(auth_code);

CREATE TABLE auth.one_time_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token_type auth.one_time_token_type NOT NULL,
  token_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_auth_one_time_tokens_email ON auth.one_time_tokens(email);
CREATE INDEX idx_auth_one_time_tokens_active_hash ON auth.one_time_tokens(token_hash) WHERE used_at IS NULL;

CREATE TABLE audit_log.auth_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID,
  actor_email TEXT,
  action audit_log.auth_action NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_auth_events_actor_id ON audit_log.auth_events(actor_id);
CREATE INDEX idx_audit_log_auth_events_created_at ON audit_log.auth_events(created_at);
