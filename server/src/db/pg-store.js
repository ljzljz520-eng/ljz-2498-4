/**
 * PostgreSQL-backed repository. Same interface as memory-store.js.
 * Connection: DATABASE_URL (required when USE_PG=1).
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const { Pool } = pg;
const here = dirname(fileURLToPath(import.meta.url));

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, p, out);
    else out[p] = v;
  }
  return out;
}

export async function createPgStore(connectionString) {
  const pool = new Pool({ connectionString: connectionString || process.env.DATABASE_URL });
  const assert = (cond, status, code, message) => {
    if (!cond) { const e = new Error(message || code); e.status = status; e.code = code; throw e; }
  };
  const one = await pool.query('select 1 as ok').then(() => true).catch((e) => {
    throw Object.assign(new Error(`PG unavailable: ${e.message}`), { status: 503, code: 'PG_UNAVAILABLE' });
  });
  // Auto-apply schema (idempotent).
  await pool.query(readFileSync(join(here, 'schema.sql'), 'utf8'));

  const q = (text, params) => pool.query(text, params);

  const mapEntity = (r) => ({
    id: r.id, resumeId: r.resume_id, kind: r.kind, fields: r.fields,
    version: Number(r.version), createdAt: r.created_at, updatedAt: r.updated_at,
  });

  return {
    kind: 'pg', pool, assert,
    async close() { await pool.end(); },

    async createResume(userId, title, profile = {}) {
      const { rows } = await q(
        'insert into resumes(user_id,title,profile) values($1,$2,$3) returning *',
        [userId, title || 'Untitled resume', JSON.stringify(profile)]);
      const r = rows[0];
      return resumeRow(r);
    },
    async updateProfile(resumeId, profile) {
      const { rows } = await q('update resumes set profile=$2, updated_at=now() where id=$1 returning *',
        [resumeId, JSON.stringify(profile)]);
      assert(rows[0], 404, 'RESUME_NOT_FOUND', 'resume not found');
      return resumeRow(rows[0]);
    },
    async getResume(id) {
      const { rows } = await q('select * from resumes where id=$1', [id]);
      return rows[0] ? resumeRow(rows[0]) : null;
    },
    async touchResume(id) { await q('update resumes set updated_at=now() where id=$1', [id]); },

    async listEntities(resumeId, kind) {
      const { rows } = kind
        ? await q('select * from entities where resume_id=$1 and kind=$2 order by created_at', [resumeId, kind])
        : await q('select * from entities where resume_id=$1 order by created_at', [resumeId]);
      return rows.map(mapEntity);
    },
    async getEntity(entityId) {
      const { rows } = await q('select * from entities where id=$1', [entityId]);
      return rows[0] ? mapEntity(rows[0]) : null;
    },
    async upsertEntity({ resumeId, entityId, kind, fields, expectedVersion }) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        let row;
        if (entityId) {
          const { rows } = await client.query('select * from entities where id=$1 for update', [entityId]);
          const e = rows[0];
          assert(e, 404, 'ENTITY_NOT_FOUND', `entity ${entityId} not found`);
          assert(e.resume_id === resumeId, 404, 'ENTITY_NOT_FOUND', 'entity belongs to another resume');
          if (expectedVersion != null) {
            assert(Number(e.version) === expectedVersion, 409, 'VERSION_CONFLICT',
              `entity version ${e.version} != expected ${expectedVersion}`);
          }
          const prev = flatten(e.fields), nxt = flatten(fields || {});
          const changed = [...new Set([...Object.keys(prev), ...Object.keys(nxt)])]
            .filter((p) => JSON.stringify(prev[p]) !== JSON.stringify(nxt[p])).map((p) => `$:${p}`);
          const r2 = await client.query(
            'update entities set fields=$2, version=version+1, updated_at=now() where id=$1 returning *',
            [entityId, JSON.stringify(fields || {})]);
          row = r2.rows[0];
          await client.query('commit');
          return { entity: mapEntity(row), changed, prevVersion: Number(e.version) };
        }
        assert(kind, 400, 'KIND_REQUIRED', 'kind required for new entity');
        const { rows } = await client.query(
          'insert into entities(resume_id,kind,fields) values($1,$2,$3) returning *',
          [resumeId, kind, JSON.stringify(fields || {})]);
        row = rows[0];
        await client.query('commit');
        return { entity: mapEntity(row), changed: Object.keys(flatten(fields || {})).map((p) => `$:${p}`), prevVersion: 0 };
      } catch (e) { await client.query('rollback'); throw e; }
      finally { client.release(); }
    },

    async setFieldPrivacy(resumeId, fieldPath, purposes) {
      const { rows } = await q(`insert into field_privacy(resume_id,field_path,purposes)
        values($1,$2,$3) on conflict (resume_id,field_path)
        do update set purposes=excluded.purposes, updated_at=now() returning *`,
      [resumeId, fieldPath, JSON.stringify([...new Set(purposes)])]);
      const r = rows[0];
      return { resumeId: r.resume_id, fieldPath: r.field_path, purposes: r.purposes, updatedAt: r.updated_at };
    },
    async listFieldPrivacy(resumeId) {
      const { rows } = await q('select * from field_privacy where resume_id=$1', [resumeId]);
      return rows.map((r) => ({ resumeId: r.resume_id, fieldPath: r.field_path, purposes: r.purposes, updatedAt: r.updated_at }));
    },

    async upsertBranch({ resumeId, key, name, page, items, expectedVersion }) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const sel = await client.query('select * from branches where resume_id=$1 and key=$2 for update', [resumeId, key]);
        let b = sel.rows[0];
        if (b && expectedVersion != null) {
          assert(Number(b.version) === expectedVersion, 409, 'VERSION_CONFLICT',
            `branch version ${b.version} != expected ${expectedVersion}`);
        }
        if (!b) {
          const ins = await client.query(
            `insert into branches(resume_id,key,name,page,items) values($1,$2,$3,
               coalesce($4,'{"width":595,"height":842,"margin":48}'::jsonb),'[]'::jsonb) returning *`,
            [resumeId, key, name || key, page ? JSON.stringify(page) : null]);
          b = ins.rows[0];
        }
        const r2 = await client.query(`update branches set
             name=coalesce($3,name),
             page=coalesce($4,page),
             items=coalesce($5,items),
             version=version+1, updated_at=now()
           where id=$1 returning *`,
        [b.id, b.resume_id, name ?? null, page ? JSON.stringify(page) : null, items ? JSON.stringify(items) : null]);
        await client.query('commit');
        const r = r2.rows[0];
        return {
          id: r.id, resumeId: r.resume_id, key: r.key, name: r.name, page: r.page,
          items: r.items, version: Number(r.version), createdAt: r.created_at, updatedAt: r.updated_at,
        };
      } catch (e) { await client.query('rollback'); throw e; }
      finally { client.release(); }
    },
    async getBranch(resumeId, key) {
      const { rows } = await q('select * from branches where resume_id=$1 and key=$2', [resumeId, key]);
      const r = rows[0];
      return r ? {
        id: r.id, resumeId: r.resume_id, key: r.key, name: r.name, page: r.page,
        items: r.items, version: Number(r.version), createdAt: r.created_at, updatedAt: r.updated_at,
      } : null;
    },
    async listBranches(resumeId) {
      const { rows } = await q('select * from branches where resume_id=$1', [resumeId]);
      return rows.map((r) => ({
        id: r.id, resumeId: r.resume_id, key: r.key, name: r.name, page: r.page,
        items: r.items, version: Number(r.version), createdAt: r.created_at, updatedAt: r.updated_at,
      }));
    },

    async createShare(rec) {
      await q(`insert into shares(token,resume_id,branch_key,purpose,content,render,template_key,template_ver,revoked)
        values($1,$2,$3,$4,$5,$6,$7,$8,false)`,
      [rec.token, rec.resumeId, rec.branchKey, rec.purpose, JSON.stringify(rec.content),
        JSON.stringify(rec.render), rec.templateKey, rec.templateVer]);
      return this.getShare(rec.token);
    },
    async getShare(token) {
      const { rows } = await q('select * from shares where token=$1', [token]);
      const r = rows[0];
      if (!r) return null;
      return {
        token: r.token, resumeId: r.resume_id, branchKey: r.branch_key, purpose: r.purpose,
        content: r.content, render: r.render, templateKey: r.template_key, templateVer: r.template_ver,
        revoked: r.revoked, createdAt: r.created_at,
      };
    },
    async revokeShare(token) { await q('update shares set revoked=true where token=$1', [token]); },

    async createExport(rec) {
      const { rows } = await q(`insert into exports(resume_id,branch_key,purpose,format,template_key,template_ver)
        values($1,$2,$3,$4,$5,$6) returning *`,
      [rec.resumeId, rec.branchKey, rec.purpose, rec.format, rec.templateKey, rec.templateVer]);
      return exportRow(rows[0]);
    },
    async getExport(id) { const { rows } = await q('select * from exports where id=$1', [id]); return rows[0] ? exportRow(rows[0]) : null; },
    async listExports(resumeId) {
      const { rows } = await q('select * from exports where resume_id=$1 order by created_at desc', [resumeId]);
      return rows.map(exportRow);
    },
    async finishExport(id, patch) {
      const { rows } = await q(`update exports set status=$2,error=$3,file_path=$4,sha256=$5,byte_size=$6,finished_at=now()
        where id=$1 returning *`,
      [id, patch.status, patch.error ?? null, patch.filePath ?? null, patch.sha256 ?? null, patch.byteSize ?? null]);
      return exportRow(rows[0]);
    },

    async enqueueJob(rec) {
      const { rows } = await q(`insert into render_jobs(export_id,resume_id,branch_key,state_version)
        values($1,$2,$3,$4) returning *`,
      [rec.exportId ?? null, rec.resumeId, rec.branchKey, rec.stateVersion ?? 0]);
      return jobRow(rows[0]);
    },
    async casJobState(jobId, from, to, patch = {}) {
      const sets = [];
      const vals = [jobId, from, to];
      if (patch.result !== undefined) { sets.push(`result=$${vals.length + 1}`); vals.push(JSON.stringify(patch.result)); }
      if (patch.error !== undefined) { sets.push(`error=$${vals.length + 1}`); vals.push(patch.error); }
      const sql = `update render_jobs set state=$3, updated_at=now()${sets.length ? ',' + sets.join(',') : ''}
        where id=$1 and state=$2 returning *`;
      const { rows } = await q(sql, vals);
      return rows[0] ? jobRow(rows[0]) : null;
    },
    async getJob(id) { const { rows } = await q('select * from render_jobs where id=$1', [id]); return rows[0] ? jobRow(rows[0]) : null; },

    async lockTemplate(resumeId, branchKey, templateKey, templateVer) {
      await q(`insert into templates_locked(resume_id,branch_key,template_key,template_ver)
        values($1,$2,$3,$4) on conflict (resume_id,branch_key)
        do update set template_key=excluded.template_key, template_ver=excluded.template_ver, locked_at=now()`,
      [resumeId, branchKey, templateKey, templateVer]);
    },
    async getLockedTemplate(resumeId, branchKey) {
      const { rows } = await q('select * from templates_locked where resume_id=$1 and branch_key=$2', [resumeId, branchKey]);
      const r = rows[0];
      return r ? { resumeId: r.resume_id, branchKey: r.branch_key, templateKey: r.template_key, templateVer: r.template_ver, lockedAt: r.locked_at } : null;
    },
  };

  function resumeRow(r) {
    return { id: r.id, userId: r.user_id, title: r.title, profile: r.profile, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  function exportRow(r) {
    return {
      id: r.id, resumeId: r.resume_id, branchKey: r.branch_key, purpose: r.purpose, format: r.format,
      templateKey: r.template_key, templateVer: r.template_ver, status: r.status, error: r.error,
      filePath: r.file_path, sha256: r.sha256, byteSize: r.byte_size, createdAt: r.created_at, finishedAt: r.finished_at,
    };
  }
  function jobRow(r) {
    return {
      id: r.id, exportId: r.export_id, resumeId: r.resume_id, branchKey: r.branch_key,
      state: r.state, stateVersion: Number(r.state_version), result: r.result, error: r.error,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }
}
