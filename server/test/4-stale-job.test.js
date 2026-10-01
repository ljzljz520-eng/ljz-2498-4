import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startApp, seedResume } from './helpers.js';
import { createExportJob, runJob } from '../src/domain/exports.js';

test('旧任务迟到：基于旧分支版本的任务被标记 superseded，不覆盖新结果、不产出文件', async () => {
  const t = await startApp();
  try {
    const { id, entities } = await seedResume(t, { overflow: false });

    // job #1 created against current branch version
    const j1 = await createExportJob({ store: t.store, resumeId: id, branchKey: 'onepage',
      purpose: 'apply_public', format: 'pdf', outputDir: t.outputDir });

    // content changes (another device toggles an item) => branch version advances
    await t.j(`/api/resumes/${id}/branches/onepage/items`, { method: 'POST', body: {
      entityId: entities.p1.id, kind: 'project', selected: false } });
    let branch = await t.store.getBranch(id, 'onepage');
    const vAfter = branch.version;

    // the old job finally runs; server now sees version vAfter > job.stateVersion
    const staleRun = await runJob({ store: t.store, jobId: j1.job.id, outputDir: t.outputDir, nowVersion: vAfter });
    assert.equal(staleRun.state, 'superseded');
    const staleJob = await t.store.getJob(j1.job.id);
    assert.equal(staleJob.state, 'superseded');
    const staleExport = await t.store.getExport(j1.export.id);
    assert.equal(staleExport.status, 'failed');
    assert.equal(staleExport.error, 'SUPERSEDED_BY_NEWER_CONTENT');
    assert.equal(staleExport.filePath, null, 'no file for stale export');

    // a fresh job completes normally and is not touched by the stale one
    const j2 = await createExportJob({ store: t.store, resumeId: id, branchKey: 'onepage',
      purpose: 'apply_public', format: 'pdf', outputDir: t.outputDir });
    const freshRun = await runJob({ store: t.store, jobId: j2.job.id, outputDir: t.outputDir, nowVersion: vAfter });
    assert.equal(freshRun.state, 'done');
    const freshExport = await t.store.getExport(j2.export.id);
    assert.equal(freshExport.status, 'ok');
    assert.ok(fs.existsSync(freshExport.filePath), 'fresh export file exists and is readable');

    // duplicate late execution of j2 must be a no-op (cannot overwrite)
    const dup = await runJob({ store: t.store, jobId: j2.job.id, outputDir: t.outputDir, nowVersion: vAfter });
    assert.equal(dup.state, 'noop');
  } finally {
    await t.stop();
  }
});
