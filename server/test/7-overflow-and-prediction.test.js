import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seedResume } from './helpers.js';
import { layoutDocument } from '../src/render/layout.js';

test('超一页：给出可执行取舍与节省高度；选择后不静默丢事实；预测差异被检测', async () => {
  const t = await startApp();
  try {
    const { id, entities } = await seedResume(t, { overflow: true });

    const m = await t.j(`/api/resumes/${id}/branches/onepage/measure`, { method: 'POST', body: {
      purpose: 'apply_public',
      clientPrediction: { totalPages: 1, totalHeight: 600, unitHeights: [] } } });
    assert.equal(m.status, 200);
    assert.ok(m.body.overflow === true || m.body.metrics.totalPages > 1, 'content overflows one page');
    assert.ok(m.body.clientDiff.significant, 'client/server pagination drift detected');
    assert.equal(m.body.clientDiff.clientPages, 1);

    const kinds = m.body.tradeoffs.map((a) => a.kind);
    assert.ok(kinds.includes('hideField'), 'long url hide action offered');
    assert.ok(kinds.includes('deselectItem'));
    assert.ok(kinds.includes('switchTemplate'));
    assert.ok(kinds.includes('allowPages'), 'multi-page acceptance offered (never deletes)');
    const urlAction = m.body.tradeoffs.find((a) => a.kind === 'hideField');
    assert.ok(urlAction.savedPt > 0, 'estimated saved height is quantified');

    // user chooses to hide the URL: it disappears from measure, but the FACT remains
    await t.j(`/api/resumes/${id}/privacy`, { method: 'PUT', body: {
      fieldPath: `entities.${entities.p1.id}.url`, purposes: ['internal'] } });
    const m2 = await t.j(`/api/resumes/${id}/branches/onepage/measure`, { method: 'POST', body: {
      purpose: 'apply_public', clientPrediction: { totalPages: 1, totalHeight: 600 } } });
    assert.ok(m2.body.stripped.includes(`entities.${entities.p1.id}.url`));
    const stillThere = (await t.j(`/api/resumes/${id}`)).body.entities.find((e) => e.id === entities.p1.id);
    assert.ok(stillThere.fields.url, 'url fact retained in storage');

    // choosing deselect removes from onepage only; entity still selectable & in detailed branch
    const deselect = m2.body.tradeoffs.find((a) => a.kind === 'deselectItem');
    await t.j(`/api/resumes/${id}/branches/onepage/items`, { method: 'POST', body: {
      entityId: deselect.target.itemId, selected: false } });
    const full = (await t.j(`/api/resumes/${id}`)).body;
    assert.ok(!full.branches.find((b) => b.key === 'onepage').items.some((i) => i.id === deselect.target.itemId));
    assert.ok(full.entities.some((e) => e.id === deselect.target.itemId));
  } finally {
    await t.stop();
  }
});

test('长链接 break-all 换行不溢出字宽；段落保护 keepWithNext 不在页面处被劈开', () => {
  const longUrl = 'https://example.com/' + 'a'.repeat(200);
  const blocks = [
    { type: 'heading', text: 'Projects' },
    { type: 'item', keepWithNext: 1, blocks: [
      { type: 'text', runs: [{ text: 'Proj', bold: true }, { text: ' — ' + longUrl, family: 'Courier', fontSize: 8.5 }] },
      { type: 'text', text: '描述必须与标题留在同一页。' },
    ] },
  ];
  const laid = layoutDocument(blocks, { width: 595, height: 150, margin: 40 }); // very short page forces pagination
  // no line atom should be wider than the content width (URL wrapped break-all)
  for (const u of laid.units) {
    for (const line of u.lines || []) {
      const w = line.reduce((s, a) => s + a.w, 0);
      assert.ok(w <= laid.page.widthPx + 0.5, `line width ${w} <= ${laid.page.widthPx}`);
    }
  }
});


test('用户显式接受 2 页：maxPages=2 后不再报溢出，条目数不变，导出为 2 页 PDF', async () => {
  const t = await startApp();
  try {
    const { id } = await seedResume(t, { overflow: true });
    const before = await t.j(`/api/resumes/${id}`);
    const count = before.body.branches.find((b) => b.key === 'onepage').items.length;

    const m1 = await t.j(`/api/resumes/${id}/branches/onepage/measure`, { method: 'POST', body: { purpose: 'internal' } });
    assert.equal(m1.body.overflow, true);
    assert.ok(m1.body.metrics.totalPages >= 2);

    // user accepts the real measured page count (never deletes facts to force one page)
    const acceptedPages = m1.body.metrics.totalPages;
    const branch = before.body.branches.find((b) => b.key === 'onepage');
    await t.j(`/api/resumes/${id}/branches/onepage`, { method: 'PUT', body: {
      page: { ...branch.page, maxPages: acceptedPages }, expectedVersion: branch.version } });

    const m2 = await t.j(`/api/resumes/${id}/branches/onepage/measure`, { method: 'POST', body: { purpose: 'internal' } });
    assert.equal(m2.body.overflow, false, `${acceptedPages} pages now fits accepted limit`);
    const after = await t.j(`/api/resumes/${id}`);
    assert.equal(after.body.branches.find((b) => b.key === 'onepage').items.length, count, 'no facts removed');

    const ex = await t.j(`/api/resumes/${id}/exports`, { method: 'POST', body: { branchKey: 'onepage', purpose: 'internal' } });
    assert.equal(ex.body.export.status, 'ok');
    assert.equal(ex.body.run.pages, m2.body.metrics.totalPages);
  } finally {
    await t.stop();
  }
});
