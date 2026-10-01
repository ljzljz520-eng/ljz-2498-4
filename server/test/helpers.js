import { createMemoryStore } from '../src/db/memory-store.js';
import { createApp } from '../src/http/app.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let dirCounter = 0;

export async function startApp({ fsImpl } = {}) {
  const store = createMemoryStore();
  const outputDir = mkdtempSync(path.join(tmpdir(), `rf-test-${process.pid}-${++dirCounter}-`));
  const app = createApp(store, { outputDir, fsImpl });
  await new Promise((r) => (app._srv = app.listen(0, r)));
  const port = app._srv.address().port;
  const base = `http://127.0.0.1:${port}`;
  const j = async (p, opts = {}) => {
    const res = await fetch(base + p, { headers: { 'content-type': 'application/json' }, ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  };
  return {
    store, base, j,
    outputDir,
    stop: () => new Promise((res) => app._srv.close(() => { rmSync(outputDir, { recursive: true, force: true }); res(); })),
  };
}

export async function seedResume(t, { overflow = true } = {}) {
  const r = await t.j('/api/resumes', { method: 'POST', body: {
    profile: { name: '张三', email: 'z@x.com', phone: '138 0000 0000', site: 'https://z.dev/a/very/long/path/to/portfolio' } } });
  const id = r.body.resume.id;
  const mk = async (kind, fields) => {
    const x = await t.j(`/api/resumes/${id}/entities`, { method: 'POST', body: { kind, fields } });
    return x.body.entity;
  };
  const e1 = await mk('experience', { role: '资深工程师', company: '甲公司',
    summary: overflow ? '负责核心架构与性能优化。带领团队完成多个关键项目交付，建立排版度量与回归基线，跨团队推动标准落地。'.repeat(70) : '工程师。' });
  const e2 = await mk('experience', { role: '工程师', company: '乙公司', summary: '参与平台建设。' });
  const p1 = await mk('project', { name: 'ResumeForge',
    url: 'https://github.com/example/resumeforge/blob/long/packages/render/src/layout-engine.ts?ref=abcdef0#paragraph-protection-and-long-url-wrapping',
    description: '多版式渲染内核，含字体回退与原子写入。' });
  const ed = await mk('education', { school: '某某大学', degree: '计算机 本科' });
  for (const e of [e1, e2, p1, ed]) {
    await t.j(`/api/resumes/${id}/branches/onepage/items`, { method: 'POST', body: { entityId: e.id, kind: e.kind, selected: true } });
  }
  return { id, entities: { e1, e2, p1, ed } };
}
