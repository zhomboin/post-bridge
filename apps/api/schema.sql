CREATE TABLE IF NOT EXISTS account (
 id text PRIMARY KEY CHECK(id='csdn-main'),
 username text NOT NULL,
 display_name text NOT NULL,
 status text NOT NULL DEFAULT 'unchecked',
 last_checked_at timestamptz,
 last_error text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS jobs (
 id text PRIMARY KEY,
 request_id text NOT NULL UNIQUE,
 fingerprint text NOT NULL,
 record jsonb NOT NULL,
 created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs(created_at,id);
CREATE TABLE IF NOT EXISTS worker_proofs (
 worker_id text PRIMARY KEY,
 seen_at timestamptz NOT NULL,
 browser_idle boolean NOT NULL,
 profile_available boolean NOT NULL
);
CREATE TABLE IF NOT EXISTS admins (
 username text PRIMARY KEY,
 password_hash text NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash text PRIMARY KEY,
 username text NOT NULL REFERENCES admins(username),
 csrf_token text NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS logs (
 id bigserial PRIMARY KEY,
 job_id text NOT NULL DEFAULT '',
 attempt integer NOT NULL DEFAULT 0,
 level text NOT NULL,
 stage text NOT NULL,
 message text NOT NULL,
 created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS logs_created_idx ON logs(created_at);
CREATE INDEX IF NOT EXISTS logs_job_idx ON logs(job_id,created_at);
CREATE TABLE IF NOT EXISTS admin_decisions (
 id bigserial PRIMARY KEY,
 job_id text NOT NULL REFERENCES jobs(id),
 note text NOT NULL,
 created_at timestamptz NOT NULL
);

ALTER TABLE account ADD COLUMN IF NOT EXISTS remote_login_id text NOT NULL DEFAULT '';
