-- CV Studio schema (PGlite / PostgreSQL compatible)

CREATE TABLE IF NOT EXISTS resumes (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS branches (
  id               TEXT PRIMARY KEY,
  resume_id        TEXT NOT NULL REFERENCES resumes(id),
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('main','draft')),
  parent_commit_id TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived         BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS commits (
  id         TEXT PRIMARY KEY,
  branch_id  TEXT NOT NULL REFERENCES branches(id),
  parent_id  TEXT,
  doc        JSONB NOT NULL,
  message    TEXT NOT NULL DEFAULT '',
  author     TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_commits_branch ON commits(branch_id, created_at);

CREATE TABLE IF NOT EXISTS branch_heads (
  branch_id TEXT PRIMARY KEY REFERENCES branches(id),
  commit_id TEXT NOT NULL REFERENCES commits(id)
);

-- Variant visibility state (one-page / detailed). Content facts live in
-- commits; this row only says what THIS variant shows.
CREATE TABLE IF NOT EXISTS variants (
  id         TEXT PRIMARY KEY,
  resume_id  TEXT NOT NULL REFERENCES resumes(id),
  kind       TEXT NOT NULL CHECK (kind IN ('one_page','detailed')),
  name       TEXT NOT NULL,
  branch_id  TEXT NOT NULL REFERENCES branches(id),
  state      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only field lineage (common-field updates are traceable)
CREATE TABLE IF NOT EXISTS field_lineage (
  id         BIGSERIAL PRIMARY KEY,
  resume_id  TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  field      TEXT,
  old_value  TEXT NOT NULL DEFAULT '',
  new_value  TEXT NOT NULL DEFAULT '',
  rev_before INTEGER NOT NULL,
  rev_after  INTEGER NOT NULL,
  base_rev   INTEGER NOT NULL,
  merged     BOOLEAN NOT NULL DEFAULT FALSE,
  author     TEXT NOT NULL DEFAULT '',
  at         TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lineage_entity ON field_lineage(entity_id, at);

-- Append-only entity revisions enabling 3-way merge across two devices
CREATE TABLE IF NOT EXISTS entity_revs (
  entity_id  TEXT NOT NULL,
  rev        INTEGER NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  fields     JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (entity_id, rev)
);

CREATE TABLE IF NOT EXISTS snapshots (
  id               TEXT PRIMARY KEY,
  variant_id       TEXT NOT NULL,
  resume_id        TEXT NOT NULL,
  branch_id        TEXT NOT NULL,
  commit_id        TEXT NOT NULL,
  template_id      TEXT NOT NULL,
  template_version TEXT NOT NULL,
  purpose          TEXT NOT NULL,
  compiled         JSONB NOT NULL,
  metrics          JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS share_links (
  token       TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  revoked     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS export_records (
  id          TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  purpose     TEXT NOT NULL,
  format      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed')),
  path        TEXT,
  error       TEXT,
  token       BIGINT NOT NULL,
  superseded  BOOLEAN NOT NULL DEFAULT FALSE,
  bytes       INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_exports_snapshot ON export_records(snapshot_id, token);
