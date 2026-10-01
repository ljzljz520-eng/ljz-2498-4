/**
 * In-process store with the same semantics as schema.sql, used for local dev/tests.
 * Version counters and CAS transitions mirror the PG repository.
 */
import { randomUUID } from 'node:crypto';

export function createMemoryStore() {
  const db = {
    resumes: new Map(),
    entities: new Map(), // id -> {id,resumeId,kind,fields,version,createdAt,updatedAt}
    fieldPrivacy: new Map(), // `${resumeId}:${fieldPath}`
    branches: new Map(), // `${resumeId}:${key}`
    shares: new Map(), // token
    exports: new Map(),
    renderJobs: new Map(),
    templatesLocked: new Map(), // `${resumeId}:${branchKey}`
  };

  const now = () => new Date().toISOString();
  const id = randomUUID;
  const clone = (v) => JSON.parse(JSON.stringify(v));

  function assert(cond, status, code, message) {
    if (!cond) {
      const e = new Error(message || code);
      e.status = status; e.code = code;
      throw e;
    }
  }

  return {
    kind: 'memory',
    assert,
    now, id, clone,
    client: db,

    async createResume(userId, title, profile = {}) {
      const r = { id: id(), userId, title: title || 'Untitled resume', profile: clone(profile), createdAt: now(), updatedAt: now() };
      db.resumes.set(r.id, r);
      return clone(r);
    },
    async updateProfile(resumeId, profile) {
      const r = db.resumes.get(resumeId);
      assert(r, 404, 'RESUME_NOT_FOUND', 'resume not found');
      r.profile = clone(profile); r.updatedAt = now();
      return clone(r);
    },
    async getResume(resumeId) {
      const r = db.resumes.get(resumeId);
      return r ? clone(r) : null;
    },
    async touchResume(resumeId) {
      const r = db.resumes.get(resumeId);
      if (r) r.updatedAt = now();
    },

    async listEntities(resumeId, kind) {
      return [...db.entities.values()]
        .filter((e) => e.resumeId === resumeId && (!kind || e.kind === kind))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(clone);
    },
    async getEntity(entityId) {
      const e = db.entities.get(entityId);
      return e ? clone(e) : null;
    },
    /**
     * Insert or update a shared fact.
     * @returns {{entity:object, changed:string[], prevVersion:number}}
     */
    async upsertEntity({ resumeId, entityId, kind, fields, expectedVersion }) {
      let e = entityId ? db.entities.get(entityId) : null;
      if (entityId) assert(e, 404, 'ENTITY_NOT_FOUND', `entity ${entityId} not found`);
      if (e) {
        assert(e.resumeId === resumeId, 404, 'ENTITY_NOT_FOUND', 'entity belongs to another resume');
        if (expectedVersion != null) {
          assert(e.version === expectedVersion, 409, 'VERSION_CONFLICT',
            `entity version ${e.version} != expected ${expectedVersion}`);
        }
        const changed = diffPaths(e.fields, fields);
        const prevVersion = e.version;
        e.fields = clone(fields);
        e.version += 1;
        e.updatedAt = now();
        return { entity: clone(e), changed, prevVersion };
      }
      assert(kind, 400, 'KIND_REQUIRED', 'kind required for new entity');
      e = { id: id(), resumeId, kind, fields: clone(fields || {}), version: 1, createdAt: now(), updatedAt: now() };
      db.entities.set(e.id, e);
      return { entity: clone(e), changed: Object.keys(flatten(fields || {})).map((p) => `$:${p}`), prevVersion: 0 };
    },

    async setFieldPrivacy(resumeId, fieldPath, purposes) {
      const key = `${resumeId}:${fieldPath}`;
      const rec = { resumeId, fieldPath, purposes: [...new Set(purposes)], updatedAt: now() };
      db.fieldPrivacy.set(key, rec);
      return clone(rec);
    },
    async listFieldPrivacy(resumeId) {
      return [...db.fieldPrivacy.values()].filter((r) => r.resumeId === resumeId).map(clone);
    },

    async upsertBranch({ resumeId, key, name, page, items, expectedVersion }) {
      const bKey = `${resumeId}:${key}`;
      let b = db.branches.get(bKey);
      if (b && expectedVersion != null) {
        assert(b.version === expectedVersion, 409, 'VERSION_CONFLICT',
          `branch version ${b.version} != expected ${expectedVersion}`);
      }
      if (!b) {
        b = {
          id: id(), resumeId, key, name: name || key,
          page: page || { width: 595, height: 842, margin: 48 },
          items: [], version: 1, createdAt: now(), updatedAt: now(),
        };
        db.branches.set(bKey, b);
      }
      if (name != null) b.name = name;
      if (page) b.page = clone(page);
      // items replace semantics; entries can be dropped from selection, facts stay.
      if (items) b.items = clone(items);
      b.version += 1;
      b.updatedAt = now();
      return clone(b);
    },
    async getBranch(resumeId, key) {
      const b = db.branches.get(`${resumeId}:${key}`);
      return b ? clone(b) : null;
    },
    async listBranches(resumeId) {
      return [...db.branches.values()].filter((b) => b.resumeId === resumeId).map(clone);
    },

    async createShare(rec) {
      const row = { createdAt: now(), revoked: false, ...rec };
      db.shares.set(rec.token, row);
      return clone(row);
    },
    async getShare(token) {
      const r = db.shares.get(token);
      return r ? clone(r) : null;
    },
    async revokeShare(token) {
      const r = db.shares.get(token);
      if (r) r.revoked = true;
    },

    async createExport(rec) {
      const row = {
        id: id(), status: 'pending', error: null, filePath: null, sha256: null, byteSize: null,
        createdAt: now(), finishedAt: null, ...rec,
      };
      db.exports.set(row.id, row);
      return clone(row);
    },
    async getExport(id) {
      const r = db.exports.get(id);
      return r ? clone(r) : null;
    },
    async listExports(resumeId) {
      return [...db.exports.values()].filter((r) => r.resumeId === resumeId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone);
    },
    async finishExport(id, patch) {
      const r = db.exports.get(id);
      assert(r, 404, 'EXPORT_NOT_FOUND', 'export not found');
      Object.assign(r, patch, { finishedAt: now() });
      return clone(r);
    },

    async enqueueJob(rec) {
      const row = { id: id(), state: 'queued', result: null, error: null, createdAt: now(), updatedAt: now(), ...rec };
      db.renderJobs.set(row.id, row);
      return clone(row);
    },
    /** CAS: queued -> running. false if job no longer applicable (superseded/done). */
    async casJobState(jobId, from, to, patch = {}) {
      const j = db.renderJobs.get(jobId);
      if (!j || j.state !== from) return null;
      j.state = to;
      Object.assign(j, clone(patch));
      j.updatedAt = now();
      return clone(j);
    },
    async getJob(id) {
      const j = db.renderJobs.get(id);
      return j ? clone(j) : null;
    },

    async lockTemplate(resumeId, branchKey, templateKey, templateVer) {
      const key = `${resumeId}:${branchKey}`;
      db.templatesLocked.set(key, { resumeId, branchKey, templateKey, templateVer, lockedAt: now() });
    },
    async getLockedTemplate(resumeId, branchKey) {
      const v = db.templatesLocked.get(`${resumeId}:${branchKey}`);
      return v ? clone(v) : null;
    },
  };
}

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, p, out);
    else out[p] = v;
  }
  return out;
}
function diffPaths(prev, next) {
  const a = flatten(prev), b = flatten(next);
  const paths = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed = [];
  for (const p of paths) {
    if (JSON.stringify(a[p]) !== JSON.stringify(b[p])) changed.push(`$:${p}`);
  }
  return changed;
}
