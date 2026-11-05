CREATE TABLE IF NOT EXISTS integration_invitations (
 id text PRIMARY KEY, token_hash text NOT NULL UNIQUE, settings jsonb NOT NULL,
 expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS integration_registrations (
 id text PRIMARY KEY, invitation_id text NOT NULL UNIQUE REFERENCES integration_invitations(id),
 application jsonb NOT NULL, status text NOT NULL CHECK(status IN ('pending','approved','rejected')), created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS integration_clients (
 id text PRIMARY KEY, registration_id text NOT NULL UNIQUE REFERENCES integration_registrations(id),
 metadata jsonb NOT NULL, created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS integration_keys (
 id text PRIMARY KEY, client_id text NOT NULL REFERENCES integration_clients(id), encrypted_secret bytea NOT NULL,
 status text NOT NULL CHECK(status IN ('pending_activation','active','handover','revoked')),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS integration_keys_client ON integration_keys(client_id);
CREATE TABLE IF NOT EXISTS integration_nonces (
 client_id text NOT NULL REFERENCES integration_clients(id), key_id text NOT NULL REFERENCES integration_keys(id),
 nonce_hash text NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(client_id,key_id,nonce_hash)
);
CREATE INDEX IF NOT EXISTS integration_nonces_expiry ON integration_nonces(expires_at);
CREATE TABLE IF NOT EXISTS integration_rate_windows (
 subject text NOT NULL, window_start bigint NOT NULL, count integer NOT NULL, PRIMARY KEY(subject,window_start)
);
CREATE TABLE IF NOT EXISTS integration_audit (
 id bigserial PRIMARY KEY, client_id text NOT NULL DEFAULT '', action text NOT NULL,
 actor text NOT NULL, created_at timestamptz NOT NULL
);
ALTER TABLE integration_clients DROP COLUMN IF EXISTS encrypted_source_secret;
UPDATE integration_clients
 SET metadata = metadata - ARRAY['source_url','source_client_id','source_key_id','source_service_id','source_environment','source_secret']
 WHERE metadata ?| ARRAY['source_url','source_client_id','source_key_id','source_service_id','source_environment','source_secret'];
UPDATE integration_registrations
 SET application = application - ARRAY['source_url','source_client_id','source_key_id','source_service_id','source_environment','source_secret']
 WHERE application ?| ARRAY['source_url','source_client_id','source_key_id','source_service_id','source_environment','source_secret'];
