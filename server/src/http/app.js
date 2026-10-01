import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { listTemplates } from '../render/templates.js';
import { measureBranch } from '../domain/measure.js';
import { createShare, readShare } from '../domain/shares.js';
import { createExportJob, runJob } from '../domain/exports.js';

export function createApp(store, opts = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const outputDir = opts.outputDir || path.join(process.cwd(), '.output');
  fs.mkdirSync(outputDir, { recursive: true });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  app.get('/health', (req, res) => res.json({ ok: true, store: store.kind }));
  app.get('/api/templates', (req, res) => res.json({ templates: listTemplates() }));

  // ---- resumes ----
  app.post('/api/resumes', wrap(async (req, res) => {
    const r = await store.createResume(req.body.userId || 'anon', req.body.title, req.body.profile || {});
    // default branches
    await store.upsertBranch({ resumeId: r.id, key: 'onepage', name: '一页版',
      page: { width: 595, height: 842, margin: 48, maxPages: 1 }, items: [] });
    await store.upsertBranch({ resumeId: r.id, key: 'detailed', name: '详细版',
      page: { width: 595, height: 842, margin: 48 }, items: [] });
    res.status(201).json({ resume: r });
  }));

  app.get('/api/resumes/:id', wrap(async (req, res) => {
    const r = await store.getResume(req.params.id);
    if (!r) return res.status(404).json({ error: 'RESUME_NOT_FOUND' });
    const [entities, branches, privacy] = await Promise.all([
      store.listEntities(r.id), store.listBranches(r.id), store.listFieldPrivacy(r.id)]);
    res.json({ resume: r, entities, branches, privacy });
  }));

  app.put('/api/resumes/:id/profile', wrap(async (req, res) => {
    const r = await store.updateProfile(req.params.id, req.body.profile || {});
    res.json({ resume: r });
  }));

  // ---- shared entities (facts) ----
  app.post('/api/resumes/:id/entities', wrap(async (req, res) => {
    const resumeId = req.params.id;
    const { entityId, kind, fields, expectedVersion } = req.body;
    const result = await store.upsertEntity({ resumeId, entityId, kind, fields, expectedVersion });
    // auto-include new facts in detailed branch; one-page selection stays explicit (never auto-padded)
    if (!entityId) {
      const detailed = await store.getBranch(resumeId, 'detailed');
      if (detailed) {
        await store.upsertBranch({
          resumeId, key: 'detailed',
          items: [...detailed.items, { kind, id: result.entity.id, detailLevel: 'full' }],
        });
      }
    }
    res.status(entityId ? 200 : 201).json({ entity: result.entity, changed: result.changed, prevVersion: result.prevVersion });
  }));

  // ---- field privacy ----
  app.put('/api/resumes/:id/privacy', wrap(async (req, res) => {
    const { fieldPath, purposes } = req.body;
    const rec = await store.setFieldPrivacy(req.params.id, fieldPath, purposes || []);
    res.json({ privacy: rec });
  }));

  // ---- branches ----
  app.get('/api/resumes/:id/branches/:key', wrap(async (req, res) => {
    const b = await store.getBranch(req.params.id, req.params.key);
    if (!b) return res.status(404).json({ error: 'BRANCH_NOT_FOUND' });
    res.json({ branch: b });
  }));

  app.put('/api/resumes/:id/branches/:key', wrap(async (req, res) => {
    const b = await store.upsertBranch({
      resumeId: req.params.id, key: req.params.key,
      name: req.body.name, page: req.body.page, items: req.body.items,
      expectedVersion: req.body.expectedVersion,
    });
    res.json({ branch: b });
  }));

  // Select/deselect an item for a branch (selection only; facts are never deleted).
  app.post('/api/resumes/:id/branches/:key/items', wrap(async (req, res) => {
    const { kind, entityId, detailLevel, selected, expectedVersion } = req.body;
    const b0 = await store.getBranch(req.params.id, req.params.key);
    if (!b0) return res.status(404).json({ error: 'BRANCH_NOT_FOUND' });
    if (expectedVersion != null && b0.version !== expectedVersion) {
      return res.status(409).json({ error: 'VERSION_CONFLICT', current: b0.version, branch: b0 });
    }
    let items = b0.items;
    if (selected) {
      if (!items.some((i) => i.id === entityId)) items = [...items, { kind, id: entityId, detailLevel: detailLevel || 'full' }];
    } else {
      items = items.filter((i) => i.id !== entityId); // removed from view only
    }
    const b = await store.upsertBranch({ resumeId: req.params.id, key: req.params.key, items });
    res.json({ branch: b, note: selected ? undefined : '条目已从该版式移除，事实仍保留在简历与其它版式中' });
  }));

  // ---- measure: server truth + client prediction diff ----
  app.post('/api/resumes/:id/branches/:key/measure', wrap(async (req, res) => {
    const resumeId = req.params.id, key = req.params.key;
    const [resume, branch, entities, privacy] = await Promise.all([
      store.getResume(resumeId), store.getBranch(resumeId, key),
      store.listEntities(resumeId), store.listFieldPrivacy(resumeId)]);
    if (!resume) return res.status(404).json({ error: 'RESUME_NOT_FOUND' });
    if (!branch) return res.status(404).json({ error: 'BRANCH_NOT_FOUND' });
    const locked = await store.getLockedTemplate(resumeId, key);
    const result = measureBranch({
      branch, entities, profile: resume.profile || {}, privacy,
      purpose: req.body.purpose || 'internal',
      templateKey: req.body.templateKey || locked?.templateKey || 'classic',
      templateVersion: req.body.templateVersion || locked?.templateVer,
      clientPrediction: req.body.clientPrediction,
      maxPages: req.body.maxPages,
      locked: !!locked,
    });
    res.json(redactMeasure(result));
  }));

  // ---- shares ----
  app.post('/api/resumes/:id/shares', wrap(async (req, res) => {
    const out = await createShare({
      store, resumeId: req.params.id,
      branchKey: req.body.branchKey || 'onepage',
      purpose: 'share_link',
      templateKey: req.body.templateKey, templateVersion: req.body.templateVersion,
    });
    res.status(201).json({ share: { ...out, url: `/api/shares/${out.token}` } });
  }));

  app.get('/api/shares/:token', wrap(async (req, res) => {
    try {
      const view = await readShare({ store, token: req.params.token });
      // Only sanitized content is returned — no raw fields, no entity dump.
      res.json(view);
    } catch (e) {
      if (e.status === 410) return res.status(410).json({ error: 'SHARE_REVOKED' });
      if (e.status === 404) return res.status(404).json({ error: 'SHARE_NOT_FOUND' });
      throw e;
    }
  }));

  app.delete('/api/shares/:token', wrap(async (req, res) => {
    await store.revokeShare(req.params.token);
    res.json({ revoked: true });
  }));

  // ---- exports ----
  app.post('/api/resumes/:id/exports', wrap(async (req, res) => {
    const { export: row, job, lockedTemplate } = await createExportJob({
      store, resumeId: req.params.id,
      branchKey: req.body.branchKey, purpose: req.body.purpose || 'internal',
      format: req.body.format || 'pdf',
      templateKey: req.body.templateKey, templateVersion: req.body.templateVersion,
      outputDir,
    });
    // run inline (tiny system). Stale-job scenario is exercised by supplying expectedVersion.
    const branch = await store.getBranch(req.params.id, req.body.branchKey || 'onepage');
    let run;
    try {
      run = await runJob({ store, jobId: job.id, outputDir, nowVersion: branch.version, fsImpl: opts.fsImpl });
    } catch (e) {
      run = { state: 'failed', error: e.message };
    }
    const finalExport = await store.getExport(row.id);
    res.status(202).json({ export: finalExport, jobId: job.id, run, lockedTemplate });
  }));

  app.get('/api/resumes/:id/exports', wrap(async (req, res) => {
    res.json({ exports: await store.listExports(req.params.id) });
  }));

  app.post('/api/resumes/:id/branches/:key/lock-template', wrap(async (req, res) => {
    const { templateKey, templateVersion } = req.body;
    await store.lockTemplate(req.params.id, req.params.key, templateKey, templateVersion);
    res.json({ locked: { resumeId: req.params.id, branchKey: req.params.key, templateKey, templateVersion } });
  }));

  // ---- error handler: map domain errors ----
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500 && process.env.NODE_ENV !== 'test') console.error(err);
    res.status(status).json({ error: err.code || 'INTERNAL', message: err.message });
  });

  return app;
}

function redactMeasure(result) {
  const { _laid, ...rest } = result;
  return rest;
}
