-- Searchable sharing is opt-in and separate from encrypted sync objects.
CREATE TABLE kuku.memory_scopes (
 user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, auto_save BOOLEAN NOT NULL DEFAULT false,
 PRIMARY KEY(user_id,name)
);
CREATE TABLE kuku.memories (
 user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 id TEXT NOT NULL, scope TEXT NOT NULL, version BIGINT NOT NULL,
 data JSONB NOT NULL, shared BOOLEAN NOT NULL DEFAULT true,
 search TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple',coalesce(data->>'title','') || ' ' || coalesce(data->>'body','') || ' ' || coalesce(data->>'tags',''))) STORED,
 PRIMARY KEY(user_id,id), FOREIGN KEY(user_id,scope) REFERENCES kuku.memory_scopes(user_id,name)
);
CREATE INDEX memory_search_idx ON kuku.memories USING GIN(search);
CREATE INDEX memory_scope_idx ON kuku.memories(user_id,scope);
CREATE TABLE kuku.memory_changes (
 seq BIGSERIAL PRIMARY KEY,user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 id TEXT NOT NULL, client TEXT NOT NULL,before_data JSONB,after_data JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX memory_changes_user_idx ON kuku.memory_changes(user_id,seq);
CREATE TABLE kuku.memory_receipts (
 user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 client TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,result JSONB NOT NULL,
 PRIMARY KEY(user_id,client,request_id)
);
CREATE TABLE kuku.memory_oauth_clients (
 id TEXT PRIMARY KEY,name TEXT NOT NULL,redirect_uris JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE kuku.memory_grants (
 id UUID PRIMARY KEY,user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 client_id TEXT NOT NULL REFERENCES kuku.memory_oauth_clients(id),
 scopes TEXT[] NOT NULL, can_write BOOLEAN NOT NULL DEFAULT false,
 revoked BOOLEAN NOT NULL DEFAULT false,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),last_success TIMESTAMPTZ
);
CREATE TABLE kuku.memory_oauth_codes (
 hash TEXT PRIMARY KEY,grant_id UUID NOT NULL REFERENCES kuku.memory_grants(id) ON DELETE CASCADE,
 redirect_uri TEXT NOT NULL,challenge TEXT NOT NULL,resource TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE kuku.memory_oauth_tokens (
 hash TEXT PRIMARY KEY,grant_id UUID NOT NULL REFERENCES kuku.memory_grants(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('access','refresh')),expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX memory_tokens_grant_idx ON kuku.memory_oauth_tokens(grant_id);
