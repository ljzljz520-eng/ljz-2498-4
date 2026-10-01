import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startApp, seedResume } from './helpers.js';
import { layoutDocument } from '../src/render/layout.js';
import { renderPdf } from '../src/render/pdf-writer.js';
import { coverChar, CID_FONT } from '../src/render/fonts.js';

test('缺字回退：ASCII 用 Helvetica，CJK 回退到 STSong-Light(CID)，生僻/无覆盖字符以 ? 占位且记录警告，PDF 仍可读', async () => {
  const t = await startApp();
  try {
    const { id } = await seedResume(t);

    // inject a fact containing emoji + rare symbol (no coverage anywhere) plus CJK
    await t.j(`/api/resumes/${id}/entities`, { method: 'POST', body: {
      kind: 'project', fields: { name: '项目 A 😀 §— 测试', description: '符号 → 中文 → ascii mixed.' } } });
    const all = (await t.j(`/api/resumes/${id}`)).body.entities;
    const weird = all.find((e) => e.fields.name?.includes('😀'));
    await t.j(`/api/resumes/${id}/branches/onepage/items`, { method: 'POST', body: { entityId: weird.id, kind: 'project', selected: true } });

    const m = await t.j(`/api/resumes/${id}/branches/onepage/measure`, { method: 'POST', body: {
      purpose: 'apply_public',
      clientPrediction: { totalPages: 1, totalHeight: 700, unitHeights: [] } } });
    assert.equal(m.status, 200);
    const warnings = m.body.metrics.warnings;
    const fallbacks = warnings.filter((w) => w.type === 'FONT_FALLBACK');
    const missing = warnings.filter((w) => w.type === 'GLYPH_MISSING');
    assert.ok(fallbacks.some((w) => w.to === CID_FONT.name), 'CJK chars fallback to CID font');
    assert.ok(missing.some((w) => w.char === '😀'), 'emoji recorded as missing glyph');

    // PDF must still be produced and structurally valid
    const ex = await t.j(`/api/resumes/${id}/exports`, { method: 'POST', body: { branchKey: 'onepage', purpose: 'apply_public' } });
    assert.equal(ex.body.export.status, 'ok');
    const bytes = fs.readFileSync(ex.body.export.filePath);
    assert.ok(bytes.subarray(0, 5).toString() === '%PDF-');
    assert.ok(bytes.subarray(-5).toString().includes('%%EOF'));
    // CID font and ToUnicode both embedded for readability/copy
    const s = bytes.toString('latin1');
    assert.ok(s.includes('/Subtype /Type0'));
    assert.ok(s.includes('/ToUnicode'));
    assert.ok(s.includes('STSong-Light'));
  } finally {
    await t.stop();
  }
});

test('coverChar 回退链单元：WinAnsi 命中 / CJK 命中 / 两者都不命中', () => {
  const warns = [];
  assert.equal(coverChar(0x41, {}, warns).font, 'Helvetica'); // A
  assert.equal(coverChar(0x4e2d, {}, warns).cid, true);       // 中
  const nope = coverChar(0x1f600, {}, warns);                  // 😀
  assert.equal(nope.covered, false);
  assert.equal(nope.notdef, true);
  assert.ok(warns.some((w) => w.type === 'GLYPH_MISSING'));
});
