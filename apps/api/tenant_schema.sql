CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
  enabled boolean NOT NULL DEFAULT true,
  auth_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_username_fkey;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id text REFERENCES users(id);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS auth_version bigint NOT NULL DEFAULT 1;
ALTER TABLE account ADD COLUMN IF NOT EXISTS owner_user_id text REFERENCES users(id);
ALTER TABLE account ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE account ADD COLUMN IF NOT EXISTS credentials_revoked boolean NOT NULL DEFAULT false;
ALTER TABLE account ADD COLUMN IF NOT EXISTS connection_version bigint NOT NULL DEFAULT 1;
DROP INDEX IF EXISTS account_platform_idx;
ALTER TABLE account ADD COLUMN IF NOT EXISTS identity_claimed boolean NOT NULL DEFAULT true;
ALTER TABLE account ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX IF NOT EXISTS account_owner_identity_idx ON account(owner_user_id,platform,username);
CREATE UNIQUE INDEX IF NOT EXISTS account_identity_idx ON account(platform,username) WHERE identity_claimed;
CREATE UNIQUE INDEX IF NOT EXISTS account_native_identity_idx ON account(platform,native_user_id) WHERE native_user_id<>'' AND identity_claimed;
CREATE INDEX IF NOT EXISTS account_owner_idx ON account(owner_user_id,id);
CREATE TABLE IF NOT EXISTS account_connections (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES account(id),
  version bigint NOT NULL,
  profile_ref text NOT NULL UNIQUE,
  worker_token_hash text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  UNIQUE(account_id,version)
);
ALTER TABLE account_connections ADD COLUMN IF NOT EXISTS wanted_at timestamptz NOT NULL DEFAULT 'epoch';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS owner_user_id text REFERENCES users(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS account_id text REFERENCES account(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS connection_version bigint NOT NULL DEFAULT 1;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS request_namespace text NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS created_by text NOT NULL DEFAULT '';
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_request_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS jobs_request_namespace_idx ON jobs(owner_user_id,request_namespace,request_id) NULLS NOT DISTINCT;
CREATE UNIQUE INDEX IF NOT EXISTS account_ownership_key ON account(id,owner_user_id);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='jobs_account_owner_fk' AND conrelid='jobs'::regclass) THEN
    ALTER TABLE jobs ADD CONSTRAINT jobs_account_owner_fk FOREIGN KEY(account_id,owner_user_id) REFERENCES account(id,owner_user_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS jobs_owner_account_idx ON jobs(owner_user_id,account_id,created_at);
CREATE TABLE IF NOT EXISTS tenant_migrations (name text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS tenant_settings (id boolean PRIMARY KEY CHECK(id),bootstrap_user_id text NOT NULL REFERENCES users(id));
CREATE TABLE IF NOT EXISTS account_browser_slots (
  account_id text PRIMARY KEY REFERENCES account(id),
  owner_user_id text REFERENCES users(id),
  purpose text NOT NULL CHECK(purpose IN ('task','login')),
  expires_at timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION pb_account() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT coalesce(nullif(current_setting('post_bridge.account_id',true),''),'') $$;
CREATE OR REPLACE FUNCTION pb_user() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT coalesce(current_setting('post_bridge.user_id',true),'') $$;
CREATE OR REPLACE FUNCTION pb_caller() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT coalesce(current_setting('post_bridge.caller_id',true),'') $$;
CREATE OR REPLACE FUNCTION pb_owner() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT coalesce(nullif(pb_user(),''),(SELECT bootstrap_user_id FROM tenant_settings WHERE id),'') $$;
ALTER TABLE article_read_requests ADD COLUMN IF NOT EXISTS owner_user_id text NOT NULL DEFAULT pb_owner();
ALTER TABLE article_read_requests ADD COLUMN IF NOT EXISTS request_namespace text NOT NULL DEFAULT pb_caller();
ALTER TABLE article_read_requests DROP CONSTRAINT IF EXISTS article_read_requests_pkey;
ALTER TABLE article_read_requests ADD PRIMARY KEY(owner_user_id,request_namespace,request_id);
CREATE OR REPLACE FUNCTION pb_owns_account(target text) RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT pb_user()='' OR EXISTS(SELECT 1 FROM account WHERE id=target AND owner_user_id=pb_user()) $$;

CREATE OR REPLACE FUNCTION pb_job_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.account_id := NEW.record->>'account_id';
  NEW.request_namespace := pb_caller();
  NEW.created_by := pb_caller();
  SELECT owner_user_id,connection_version INTO NEW.owner_user_id,NEW.connection_version FROM account WHERE id=NEW.account_id;
  IF NEW.owner_user_id IS NULL AND pb_user()<>'' THEN RAISE EXCEPTION '账号归属无效'; END IF;
  NEW.record := NEW.record || jsonb_build_object('owner_user_id',NEW.owner_user_id,'connection_version',NEW.connection_version,'created_by',NEW.created_by);
  RETURN NEW;
END $$;

DO $$ DECLARE item text; BEGIN
  FOREACH item IN ARRAY ARRAY['integration_invitations','integration_registrations','integration_clients','integration_keys','integration_preparations','integration_distributions','integration_source_states','integration_authorization_revocations','integration_audit'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS owner_user_id text NOT NULL DEFAULT pb_owner()',item);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',item);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',item);
    EXECUTE format('DROP POLICY IF EXISTS tenant ON %I',item);
    EXECUTE format('CREATE POLICY tenant ON %I USING(pb_user()='''' OR owner_user_id=pb_user()) WITH CHECK(pb_user()='''' OR owner_user_id=pb_user())',item);
  END LOOP;
END $$;
ALTER TABLE integration_source_states DROP CONSTRAINT IF EXISTS integration_source_states_pkey;
ALTER TABLE integration_source_states ADD PRIMARY KEY(owner_user_id,source_id,article_id);
ALTER TABLE integration_authorization_revocations DROP CONSTRAINT IF EXISTS integration_authorization_revocations_pkey;
ALTER TABLE integration_authorization_revocations ADD PRIMARY KEY(owner_user_id,source_id,article_id,authorization_id);

CREATE OR REPLACE FUNCTION pb_registration_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT owner_user_id INTO NEW.owner_user_id FROM integration_invitations WHERE id=NEW.invitation_id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS registration_owner ON integration_registrations;
CREATE TRIGGER registration_owner BEFORE INSERT ON integration_registrations FOR EACH ROW EXECUTE FUNCTION pb_registration_owner();
CREATE OR REPLACE FUNCTION pb_account_owner_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.owner_user_id IS NOT NULL AND NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN RAISE EXCEPTION '账号不支持共享或转让'; END IF;
  IF OLD.identity_claimed AND NOT NEW.identity_claimed THEN RAISE EXCEPTION '已确认的账号归属不可解除'; END IF;
  IF OLD.username<>NEW.username OR OLD.platform<>NEW.platform OR (OLD.native_user_id<>'' AND OLD.native_user_id<>NEW.native_user_id) THEN RAISE EXCEPTION '账号身份不可替换'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS account_owner_immutable ON account;
CREATE TRIGGER account_owner_immutable BEFORE UPDATE ON account FOR EACH ROW EXECUTE FUNCTION pb_account_owner_immutable();
DROP TRIGGER IF EXISTS job_identity ON jobs;
CREATE TRIGGER job_identity BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION pb_job_identity();
CREATE OR REPLACE FUNCTION pb_session_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS NULL THEN SELECT id,auth_version INTO NEW.user_id,NEW.auth_version FROM users WHERE username=NEW.username; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS session_identity ON sessions;
CREATE TRIGGER session_identity BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION pb_session_identity();

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant ON users;
CREATE POLICY tenant ON users USING(pb_user()='' OR id=pb_user()) WITH CHECK(pb_user()='' OR id=pb_user());
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant ON sessions;
CREATE POLICY tenant ON sessions USING(pb_user()='' OR user_id=pb_user()) WITH CHECK(pb_user()='' OR user_id=pb_user());

ALTER TABLE account ENABLE ROW LEVEL SECURITY;
ALTER TABLE account FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant ON account;
CREATE POLICY tenant ON account USING(pb_user()='' OR owner_user_id=pb_user()) WITH CHECK(pb_user()='' OR owner_user_id=pb_user());

DO $$ DECLARE item text; BEGIN
  FOREACH item IN ARRAY ARRAY['account_connections','csdn_publish_presets','worker_proofs','account_note_snapshots','account_article_snapshots','account_articles','account_article_bodies'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',item);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',item);
    EXECUTE format('DROP POLICY IF EXISTS tenant ON %I',item);
    EXECUTE format('CREATE POLICY tenant ON %I USING(pb_owns_account(account_id)) WITH CHECK(pb_owns_account(account_id))',item);
  END LOOP;
END $$;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant ON jobs;
CREATE POLICY tenant ON jobs USING(pb_user()='' OR owner_user_id=pb_user()) WITH CHECK(pb_user()='' OR owner_user_id=pb_user());
DO $$ DECLARE item text; BEGIN
  FOREACH item IN ARRAY ARRAY['logs','admin_decisions','process_snapshots','article_read_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',item);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',item);
    EXECUTE format('DROP POLICY IF EXISTS tenant ON %I',item);
    EXECUTE format('CREATE POLICY tenant ON %I USING(pb_user()='''' OR EXISTS(SELECT 1 FROM jobs WHERE id=job_id)) WITH CHECK(pb_user()='''' OR EXISTS(SELECT 1 FROM jobs WHERE id=job_id))',item);
  END LOOP;
END $$;
