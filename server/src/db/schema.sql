-- ResumeForge schema. All resume *facts* live in shared entities; branches only select.
CREATE TABLE IF NOT EXISTS resumes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT 'Untitled resume',
  profile      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Shared facts. kind: experience | project | education. Fields are free-form JSON,
-- but privacy_classification of each scalar field lives in field_privacy for auditing.
CREATE TABLE IF NOT EXISTS entities (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resume_id    UUID NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('experience','project','education')),
  fields       JSONB NOT NULL DEFAULT '{}'::jsonb,
  version      INTEGER NOT NULL DEFAULT 1,             -- increments on every fact update
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entities_resume_idx ON entities(resume_id, kind);

-- Field-level privacy. purpose: 'internal' | 'apply_public' | 'apply_trusted' | 'share_link'.
-- allow=false => field must be stripped for that purpose (even from old snapshots).
CREATE TABLE IF NOT EXISTS field_privacy (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resume_id    UUID NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  field_path   TEXT NOT NULL,                         -- e.g. entities.<id>.phone
  purposes     TEXT[] NOT NULL DEFAULT '{}',          -- purposes ALLOWED
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (resume_id, field_path)
);

-- Content branches (one-page / detailed / ...). items[] = ordered list of included entity ids.
-- A fact is NEVER deleted by editing items; entries in branch_entries can be soft-removed.
CREATE TABLE IF NOT EXISTS branches (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resume_id    UUID NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,                          -- 'onepage' | 'detailed' | custom
  name         TEXT NOT NULL,
  page         JSONB NOT NULL DEFAULT '{"width":595,"height":842,"margin":48}'::jsonb,
  items        JSONB NOT NULL DEFAULT '[]'::jsonb,    -- [{kind,id,detailLevel}]
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (resume_id, key)
);

-- Immutable snapshot captured at share time. render = sanitized, purpose-filtered content.
-- Reads are ALWAYS re-filtered through current field_privacy (revocation is live).
CREATE TABLE IF NOT EXISTS shares (
  token        TEXT PRIMARY KEY,
  resume_id    UUID NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  branch_key   TEXT NOT NULL,
  purpose      TEXT NOT NULL DEFAULT 'share_link',
  content      JSONB NOT NULL,                         -- branch item id list + entity versions at capture
  render       JSONB NOT NULL,                         -- sanitized rendered payload
  template_key TEXT NOT NULL,
  template_ver TEXT NOT NULL,
  revoked      BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Export records. template_key+template_ver are LOCKED so an approved layout is restorable
-- after template updates.
CREATE TABLE IF NOT EXISTS exports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resume_id    UUID NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  branch_key   TEXT NOT NULL,
  purpose      TEXT NOT NULL,
  format       TEXT NOT NULL CHECK (format IN ('pdf','html')),
  template_key TEXT NOT NULL,
  template_ver TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','ok','failed')),
  error        TEXT,
  file_path    TEXT,
  sha256       TEXT,
  byte_size    INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);

-- Async render/export jobs with compare-and-set guard so stale late jobs cannot overwrite.
CREATE TABLE IF NOT EXISTS render_jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  export_id    UUID REFERENCES exports(id) ON DELETE SET NULL,
  resume_id    UUID NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  branch_key   TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'queued'
               CHECK (state IN ('queued','running','done','failed','superseded')),
  -- optimistic guard: applied only when state_version matches current branch content version
  state_version INTEGER NOT NULL DEFAULT 0,
  result       JSONB,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS templates_locked (
  resume_id    UUID NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  branch_key   TEXT NOT NULL,
  template_key TEXT NOT NULL,
  template_ver TEXT NOT NULL,
  locked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (resume_id, branch_key)
);
