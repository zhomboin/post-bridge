CREATE TABLE IF NOT EXISTS content_snapshots (
  account_id text PRIMARY KEY REFERENCES account(id),
  platform text NOT NULL,
  username text NOT NULL,
  native_user_id text NOT NULL,
  record jsonb NOT NULL,
  synced_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS contents (
  account_id text NOT NULL REFERENCES account(id),
  id text NOT NULL,
  record jsonb NOT NULL,
  PRIMARY KEY(account_id,id)
);
CREATE TABLE IF NOT EXISTS content_bodies (
  account_id text NOT NULL REFERENCES account(id),
  id text NOT NULL,
  username text NOT NULL,
  native_user_id text NOT NULL,
  record jsonb NOT NULL,
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,id)
);
CREATE INDEX IF NOT EXISTS contents_status_idx ON contents(account_id,(record->>'status'));
DO $$ DECLARE item text; BEGIN
  FOREACH item IN ARRAY ARRAY['content_snapshots','contents','content_bodies'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',item);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',item);
    EXECUTE format('DROP POLICY IF EXISTS tenant ON %I',item);
    EXECUTE format('CREATE POLICY tenant ON %I USING(pb_owns_account(account_id)) WITH CHECK(pb_owns_account(account_id))',item);
  END LOOP;
END $$;
