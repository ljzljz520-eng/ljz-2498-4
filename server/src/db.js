import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let singleton;

export async function openDb(dataDir = process.env.CV_PGDATA || "./data/pglite") {
  const db = new PGlite(dataDir);
  const sql = await readFile(path.join(__dirname, "schema.sql"), "utf8");
  await db.exec(sql);
  return db;
}

export async function getDb(dataDir) {
  if (!dataDir && singleton) return singleton;
  const db = await openDb(dataDir);
  if (!dataDir) singleton = db;
  return db;
}

// ---- thin helpers ----------------------------------------------------------

export async function getJson(db, sql, params = []) {
  const res = await db.query(sql, params);
  return res.rows[0] ?? null;
}

export async function listJson(db, sql, params = []) {
  const res = await db.query(sql, params);
  return res.rows;
}

// ---- resumes / branches / commits -----------------------------------------

export async function createResumeRow(db, id, title) {
  await db.query("INSERT INTO resumes (id, title) VALUES ($1, $2)", [id, title]);
}

export async function createBranchRow(db, branch, headCommitId) {
  await db.query(
    `INSERT INTO branches (id, resume_id, name, kind, parent_commit_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [branch.id, branch.resumeId, branch.name, branch.kind, branch.parentCommitId, branch.createdAt],
  );
  await db.query("INSERT INTO branch_heads (branch_id, commit_id) VALUES ($1,$2)", [
    branch.id,
    headCommitId,
  ]);
}

export async function insertCommitRow(db, commit) {
  await db.query(
    `INSERT INTO commits (id, branch_id, parent_id, doc, message, author, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      commit.id,
      commit.branchId,
      commit.parentId,
      JSON.stringify(commit.docSnapshot),
      commit.message,
      commit.author,
      commit.createdAt,
    ],
  );
  await db.query("UPDATE branch_heads SET commit_id=$1 WHERE branch_id=$2", [
    commit.id,
    commit.branchId,
  ]);
}

export async function headCommit(db, branchId) {
  const row = await getJson(
    db,
    `SELECT c.id, c.branch_id AS "branchId", c.parent_id AS "parentId",
            c.doc, c.message, c.author, c.created_at AS "createdAt"
       FROM branch_heads h JOIN commits c ON c.id = h.commit_id
      WHERE h.branch_id = $1`,
    [branchId],
  );
  return row ? hydrateCommit(row) : null;
}

function hydrateCommit(row) {
  return {
    id: row.id,
    branchId: row.branchId,
    parentId: row.parentId,
    docSnapshot: typeof row.doc === "string" ? JSON.parse(row.doc) : row.doc,
    message: row.message,
    author: row.author,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

export async function getCommit(db, commitId) {
  const row = await getJson(
    db,
    `SELECT id, branch_id AS "branchId", parent_id AS "parentId", doc, message, author,
            created_at AS "createdAt" FROM commits WHERE id=$1`,
    [commitId],
  );
  return row ? hydrateCommit(row) : null;
}

// ---- variants --------------------------------------------------------------

export async function upsertVariantRow(db, variant) {
  await db.query(
    `INSERT INTO variants (id, resume_id, kind, name, branch_id, state, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE SET state=$6, updated_at=$7, branch_id=$5`,
    [
      variant.id,
      variant.resumeId,
      variant.kind,
      variant.name,
      variant.branchId,
      JSON.stringify(variant),
      variant.updatedAt,
    ],
  );
}

export async function getVariant(db, variantId) {
  const row = await getJson(db, "SELECT state FROM variants WHERE id=$1", [variantId]);
  return row ? (typeof row.state === "string" ? JSON.parse(row.state) : row.state) : null;
}

export async function listVariants(db, resumeId) {
  const rows = await listJson(db, "SELECT state FROM variants WHERE resume_id=$1 ORDER BY kind", [
    resumeId,
  ]);
  return rows.map((r) => (typeof r.state === "string" ? JSON.parse(r.state) : r.state));
}

// ---- lineage ---------------------------------------------------------------

export async function appendLineage(db, resumeId, entries) {
  for (const e of entries) {
    await db.query(
      `INSERT INTO field_lineage
         (resume_id, entity_id, field, old_value, new_value, rev_before, rev_after,
          base_rev, merged, author, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        resumeId,
        e.entityId,
        e.field,
        e.oldValue,
        e.newValue,
        e.revBefore,
        e.revAfter,
        e.baseRev,
        e.merged,
        e.author,
        e.at,
      ],
    );
  }
}

export async function listLineage(db, entityId) {
  const rows = await listJson(
    db,
    `SELECT entity_id AS "entityId", field, old_value AS "oldValue", new_value AS "newValue",
            rev_before AS "revBefore", rev_after AS "revAfter", base_rev AS "baseRev",
            merged, author, at
       FROM field_lineage WHERE entity_id=$1 ORDER BY id`,
    [entityId],
  );
  return rows.map((r) => ({ ...r, at: r.at instanceof Date ? r.at.toISOString() : r.at }));
}

// ---- entity revisions (for multi-device merge) -----------------------------

export async function saveEntityRev(db, entity) {
  await db.query(
    `INSERT INTO entity_revs (entity_id, rev, title, fields, updated_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (entity_id, rev) DO NOTHING`,
    [entity.id, entity.rev, entity.title, JSON.stringify(entity.fields), entity.updatedAt],
  );
}

export async function getEntityRev(db, entityId, rev) {
  const row = await getJson(
    db,
    `SELECT entity_id AS "entityId", rev, title, fields, updated_at AS "updatedAt"
       FROM entity_revs WHERE entity_id=$1 AND rev=$2`,
    [entityId, rev],
  );
  if (!row) return null;
  return { ...row, fields: typeof row.fields === "string" ? JSON.parse(row.fields) : row.fields };
}

// ---- snapshots / shares / exports ------------------------------------------

export async function insertSnapshotRow(db, snap) {
  await db.query(
    `INSERT INTO snapshots
       (id, variant_id, resume_id, branch_id, commit_id, template_id, template_version,
        purpose, compiled, metrics, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      snap.id,
      snap.variantId,
      snap.resumeId,
      snap.branchId,
      snap.commitId,
      snap.templateId,
      snap.templateVersion,
      snap.purpose,
      JSON.stringify(snap.compiled),
      JSON.stringify(snap.metrics),
      snap.createdAt,
    ],
  );
}

export async function getSnapshot(db, id) {
  const row = await getJson(
    db,
    `SELECT id, variant_id AS "variantId", resume_id AS "resumeId", branch_id AS "branchId",
            commit_id AS "commitId", template_id AS "templateId",
            template_version AS "templateVersion", purpose, compiled, metrics,
            created_at AS "createdAt"
       FROM snapshots WHERE id=$1`,
    [id],
  );
  if (!row) return null;
  return {
    ...row,
    compiled: typeof row.compiled === "string" ? JSON.parse(row.compiled) : row.compiled,
    metrics: typeof row.metrics === "string" ? JSON.parse(row.metrics) : row.metrics,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

export async function insertShare(db, token, snapshotId, createdAt) {
  await db.query("INSERT INTO share_links (token, snapshot_id, created_at) VALUES ($1,$2,$3)", [
    token,
    snapshotId,
    createdAt,
  ]);
}

export async function getShare(db, token) {
  return getJson(
    db,
    `SELECT token, snapshot_id AS "snapshotId", revoked, created_at AS "createdAt"
       FROM share_links WHERE token=$1`,
    [token],
  );
}

export async function revokeShare(db, token) {
  await db.query("UPDATE share_links SET revoked=TRUE WHERE token=$1", [token]);
}

export async function insertExport(db, rec) {
  await db.query(
    `INSERT INTO export_records
       (id, snapshot_id, purpose, format, status, path, error, token, superseded,
        bytes, created_at, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      rec.id,
      rec.snapshotId,
      rec.purpose,
      rec.format,
      rec.status,
      rec.path,
      rec.error,
      rec.token,
      rec.superseded,
      rec.bytes,
      rec.createdAt,
      rec.finishedAt,
    ],
  );
}

export async function updateExport(db, id, fields) {
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    const col = { finishedAt: "finished_at" }[k] ?? k;
    sets.push(`${col}=$${i++}`);
    vals.push(v);
  }
  vals.push(id);
  await db.query(`UPDATE export_records SET ${sets.join(", ")} WHERE id=$${i}`, vals);
}

export async function getExport(db, id) {
  const row = await getJson(
    db,
    `SELECT id, snapshot_id AS "snapshotId", purpose, format, status, path, error, token,
            superseded, bytes, created_at AS "createdAt", finished_at AS "finishedAt"
       FROM export_records WHERE id=$1`,
    [id],
  );
  if (row) {
    row.createdAt = row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt;
    row.finishedAt = row.finishedAt instanceof Date ? row.finishedAt.toISOString() : row.finishedAt;
  }
  return row;
}

export async function latestExportToken(db, snapshotId) {
  const row = await getJson(
    db,
    "SELECT COALESCE(MAX(token), 0) AS t FROM export_records WHERE snapshot_id=$1",
    [snapshotId],
  );
  return Number(row.t);
}
