CREATE TABLE IF NOT EXISTS integration_preparations (
  id text PRIMARY KEY,
  client_id text NOT NULL,
  source_id text NOT NULL,
  article_id text NOT NULL,
  request_id text NOT NULL,
  fingerprint text NOT NULL,
  record jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(client_id,request_id)
);
CREATE INDEX IF NOT EXISTS integration_preparations_source_idx ON integration_preparations(source_id,article_id);
CREATE TABLE IF NOT EXISTS integration_distributions (
  id text PRIMARY KEY,
  client_id text NOT NULL,
  source_id text NOT NULL,
  article_id text NOT NULL,
  request_id text NOT NULL,
  preparation_id text NOT NULL UNIQUE REFERENCES integration_preparations(id),
  fingerprint text NOT NULL,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(client_id,request_id)
);
CREATE INDEX IF NOT EXISTS integration_distributions_source_idx ON integration_distributions(source_id,article_id);
CREATE TABLE IF NOT EXISTS integration_source_states (
  source_id text NOT NULL,
  article_id text NOT NULL,
  state_seq bigint NOT NULL CHECK(state_seq>0),
  record jsonb NOT NULL,
  PRIMARY KEY(source_id,article_id)
);
CREATE TABLE IF NOT EXISTS integration_source_events (
  client_id text NOT NULL,
  event_id text NOT NULL,
  fingerprint text NOT NULL,
  received_at timestamptz NOT NULL,
  PRIMARY KEY(client_id,event_id)
);

CREATE TABLE IF NOT EXISTS integration_authorization_revocations (
  source_id text NOT NULL,
  article_id text NOT NULL,
  authorization_id text NOT NULL,
  state_seq bigint NOT NULL CHECK(state_seq>0),
  record jsonb NOT NULL,
  PRIMARY KEY(source_id,article_id,authorization_id)
);
