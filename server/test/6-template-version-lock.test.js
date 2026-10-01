import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seedResume } from './helpers.js';
import { getTemplate, TEMPLATES } from '../src/render/templates.js';
import { layoutDocument } from '../src/render/layout.js';
import { assemble } from '../src/domain/measure.js';

async function renderAtVersion(store, id, branchKey, tplKey, tplVer) {
  const resume = await store.getResume(id);
  const branch = await store.getBranch(id, branchKey);
  const entities = await store.listEntities(id);
  const privacy = await store.listFieldPrivacy(id);
  const tpl = getTemplate(tplKey, tplVer);
  const { content } = assemble({ branch, entities, profile: resume.profile || {}, privacy, purpose: 'internal' });
  const laid = layoutDocument(tpl.render(content, {}), { ...branch.page, margin: tpl.margins });
  return laid;
}

test('模板升级后仍可恢复以前认可的排版：旧版本保留、锁定版本不漂移、渲染结果可复现', async () => {
  const t = await startApp();
  try {
    const { id } = await seedResume(t, { overflow: false });

    // approve an export explicitly pinned to classic 1.0.0
    const r1 = await t.j(`/api/resumes/${id}/exports`, { method: 'POST', body: {
      branchKey: 'onepage', purpose: 'internal', format: 'pdf',
      templateKey: 'classic', templateVersion: '1.0.0' } });
    assert.equal(r1.body.export.status, 'ok');
    assert.equal(r1.body.export.templateVer, '1.0.0');

    // registry advances: latest is 1.1.0, old version still registered
    assert.equal(TEMPLATES.classic.latest, '1.1.0');
    assert.ok(TEMPLATES.classic.versions['1.0.0'], 'old template retained');

    // the approved layout for the branch is now locked at 1.0.0
    const lock = await t.store.getLockedTemplate(id, 'onepage');
    assert.deepEqual({ k: lock.templateKey, v: lock.templateVer }, { k: 'classic', v: '1.0.0' });

    // measure with no version => lock wins (approved layout survives package update)
    const m = await t.j(`/api/resumes/${id}/branches/onepage/measure`, { method: 'POST', body: { purpose: 'internal' } });
    assert.equal(m.body.templateVersion, '1.0.0');
    assert.equal(m.body.locked, true);
    assert.equal(m.body.templateOutdated, true, 'UI is told an upgrade exists, but layout does not silently change');

    // reproducibility: rendering same content at 1.0.0 twice yields identical total height
    const laidA = await renderAtVersion(t.store, id, 'onepage', 'classic', '1.0.0');
    const laidB = await renderAtVersion(t.store, id, 'onepage', 'classic', '1.0.0');
    assert.equal(laidA.totalHeight, laidB.totalHeight);
    assert.equal(laidA.totalPages, laidB.totalPages);

    // the new version measurably differs (margins/font), proving lock actually pins something
    const laidNew = await renderAtVersion(t.store, id, 'onepage', 'classic', '1.1.0');
    assert.notEqual(laidA.totalHeight, laidNew.totalHeight);

    // user can explicitly restore / re-export the approved layout anytime
    const r2 = await t.j(`/api/resumes/${id}/exports`, { method: 'POST', body: {
      branchKey: 'onepage', purpose: 'internal', format: 'pdf' } });
    assert.equal(r2.body.export.templateVer, '1.0.0', 'new export still uses the locked approved version');
  } finally {
    await t.stop();
  }
});
