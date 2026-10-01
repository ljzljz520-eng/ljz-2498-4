/**
 * Export service: real server measurement + PDF/HTML rendering + job idempotency.
 *
 * Concurrency model:
 *  - branch save carries a monotonic version; an export is pinned to stateVersion.
 *  - render jobs transition queued -> running -> done|failed via CAS.
 *  - A stale (late) job whose stateVersion is behind the current branch is marked
 *    'superseded' and MUST NOT overwrite a newer export/job result.
 *  - Template key+version are locked on first successful export ("approved layout"),
 *    restorable after the template package updates.
 *  - PDF writes are atomic; write failure marks the export failed and leaves no partial
 *    file (previous export, if any, stays readable).
 */
import path from 'node:path';
import { getTemplate } from '../render/templates.js';
import { layoutDocument } from '../render/layout.js';
import { renderPdf, writePdfAtomic } from '../render/pdf-writer.js';
import { assemble } from './measure.js';
import { htmlFromBlocks, writeHtmlAtomic } from './exports-html.js';

export async function createExportJob({ store, resumeId, branchKey, purpose, format = 'pdf',
  templateKey, templateVersion, outputDir, fsImpl }) {
  const resume = await store.getResume(resumeId);
  store.assert(resume, 404, 'RESUME_NOT_FOUND', 'resume not found');
  let branch = await store.getBranch(resumeId, branchKey);
  store.assert(branch, 404, 'BRANCH_NOT_FOUND', 'branch not found');

  // Template lock: if this branch was previously approved, keep its exact template version
  // unless caller explicitly opts into upgrading (unlock).
  const locked = await store.getLockedTemplate(resumeId, branchKey);
  let tplKey = templateKey || locked?.templateKey || 'classic';
  let tplVer = templateVersion || locked?.templateVer || getTemplate(tplKey).version;

  const exportRow = await store.createExport({
    resumeId, branchKey, purpose, format,
    templateKey: tplKey, templateVer: tplVer,
  });
  const job = await store.enqueueJob({
    exportId: exportRow.id, resumeId, branchKey, stateVersion: branch.version,
  });
  return { export: exportRow, job, lockedTemplate: locked || null };
}

/**
 * Run a queued job. @param nowVersion current branch version (detects stale jobs).
 */
export async function runJob({ store, jobId, outputDir, nowVersion, fsImpl }) {
  let job = await store.getJob(jobId);
  store.assert(job, 404, 'JOB_NOT_FOUND', 'job not found');

  // Stale guard: content moved on while this job sat in the queue.
  if (nowVersion != null && job.stateVersion < nowVersion) {
    await store.casJobState(jobId, job.state, 'superseded', { error: 'stale: branch changed before render' });
    if (job.exportId) {
      await store.finishExport(job.exportId, { status: 'failed', error: 'SUPERSEDED_BY_NEWER_CONTENT' });
    }
    return { state: 'superseded', reason: 'stale' };
  }

  // Only a queued job may be claimed. A late duplicate of a done/failed/superseded job
  // cannot re-enter running and overwrite anything.
  if (job.state !== 'queued') {
    return { state: 'noop', reason: 'already-' + job.state };
  }
  const claimed = await store.casJobState(jobId, 'queued', 'running');
  if (!claimed) {
    return { state: 'noop', reason: 'cas-lost' };
  }
  job = claimed;

  try {
    const resume = await store.getResume(job.resumeId);
    const branch = await store.getBranch(job.resumeId, job.branchKey);
    // Defense in depth: re-check current branch version under the claim.
    if (branch.version !== job.stateVersion) {
      await store.casJobState(jobId, 'running', 'superseded', { error: `version drift: job@${job.stateVersion} branch@${branch.version}` });
      if (job.exportId) await store.finishExport(job.exportId, { status: 'failed', error: 'SUPERSEDED_BY_NEWER_CONTENT' });
      return { state: 'superseded', reason: 'version-drift' };
    }
    const entities = await store.listEntities(job.resumeId);
    const privacy = await store.listFieldPrivacy(job.resumeId);
    const exp = job.exportId ? await store.getExport(job.exportId) : null;
    const tpl = getTemplate(exp.templateKey, exp.templateVer);
    const { content, stripped } = assemble({
      branch, entities, profile: resume.profile || {}, privacy, purpose: exp.purpose,
    });
    const maxPages = branch.page?.maxPages ?? (branch.key === 'onepage' ? 1 : Infinity);
    const page = { ...branch.page, margin: tpl.margins, maxPages };
    const blocks = tpl.render(content, { purpose: exp.purpose });
    const laid = layoutDocument(blocks, page);

    let filePath = null, sha256 = null, byteSize = null;
    if (exp.format === 'pdf') {
      const bytes = renderPdf(laid);
      const target = path.join(outputDir, `${job.resumeId}_${job.branchKey}_${exp.id}.pdf`);
      const w = await writePdfAtomic(target, bytes, fsImpl);
      filePath = w.path; sha256 = w.sha256; byteSize = w.byteSize;
    } else {
      const html = htmlFromBlocks(blocks, laid, { templateKey: exp.templateKey, templateVersion: exp.templateVer });
      const target = path.join(outputDir, `${job.resumeId}_${job.branchKey}_${exp.id}.html`);
      const w = await writeHtmlAtomic(target, html, fsImpl);
      filePath = w.path; sha256 = w.sha256; byteSize = w.byteSize;
    }

    await store.finishExport(job.exportId, { status: 'ok', filePath, sha256, byteSize });
    // Lock the approved template version on first success (or keep existing lock).
    await store.lockTemplate(job.resumeId, job.branchKey, exp.templateKey, exp.templateVer);
    const done = await store.casJobState(jobId, 'running', 'done', {
      result: { pages: laid.totalPages, height: laid.totalHeight, stripped, exportId: job.exportId },
    });
    if (!done) {
      // Lost the race: another transition superseded us. Do NOT overwrite.
      return { state: 'noop', reason: 'cas-lost-after-work' };
    }
    return { state: 'done', exportId: job.exportId, filePath, pages: laid.totalPages, stripped };
  } catch (err) {
    if (job.exportId) {
      await store.finishExport(job.exportId, { status: 'failed', error: `RENDER_OR_WRITE_FAILED: ${err.message}` });
    }
    await store.casJobState(jobId, 'running', 'failed', { error: err.message });
    throw err;
  }
}
