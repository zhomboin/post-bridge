CREATE TABLE IF NOT EXISTS formatting_sessions (
 id text PRIMARY KEY,
 owner_user_id text NOT NULL REFERENCES users(id),
 request_id text NOT NULL,
 fingerprint text NOT NULL,
 record jsonb NOT NULL,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,request_id)
);
CREATE TABLE IF NOT EXISTS formatting_jobs (
 id text PRIMARY KEY,
 owner_user_id text NOT NULL REFERENCES users(id),
 session_id text NOT NULL REFERENCES formatting_sessions(id),
 request_id text NOT NULL,
 fingerprint text NOT NULL,
 record jsonb NOT NULL,
 lease_token text NOT NULL DEFAULT '',
 lease_expires_at timestamptz,
 reservation bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id, request_id)
);
CREATE INDEX IF NOT EXISTS formatting_queue_idx ON formatting_jobs(created_at) WHERE record->>'status'='queued';
CREATE INDEX IF NOT EXISTS formatting_sessions_owner_idx ON formatting_sessions(owner_user_id,created_at);
CREATE TABLE IF NOT EXISTS formatting_assets (
 id text PRIMARY KEY,
 owner_user_id text NOT NULL REFERENCES users(id),
 job_id text NOT NULL REFERENCES formatting_jobs(id),
 revision bigint NOT NULL,
 sha256 text NOT NULL,
 width integer NOT NULL,
 height integer NOT NULL,
 body bytea NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS formatting_revisions (
 job_id text NOT NULL REFERENCES formatting_jobs(id) ON DELETE CASCADE,
 owner_user_id text NOT NULL REFERENCES users(id),
 revision bigint NOT NULL,
 record jsonb NOT NULL,
 confirmed boolean NOT NULL DEFAULT false,
 confirmation_fingerprint text NOT NULL DEFAULT '',
 PRIMARY KEY(job_id,revision)
);
CREATE TABLE IF NOT EXISTS formatting_automatic (
 preparation_id text PRIMARY KEY REFERENCES integration_preparations(id) ON DELETE CASCADE,
 owner_user_id text NOT NULL REFERENCES users(id),
 status text NOT NULL DEFAULT 'queued',
 available_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['formatting_sessions','formatting_jobs','formatting_assets','formatting_revisions','formatting_automatic'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',item);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',item);
  EXECUTE format('DROP POLICY IF EXISTS tenant ON %I',item);
  EXECUTE format('CREATE POLICY tenant ON %I USING(pb_user()='''' OR owner_user_id=pb_user()) WITH CHECK(pb_user()='''' OR owner_user_id=pb_user())',item);
 END LOOP;
END $$;
