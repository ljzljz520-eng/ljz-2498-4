import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seedResume } from './helpers.js';

test('两设备改同一经历：后保存者得到 409，必须基于新版本重试；共享字段更新在两个版式中都可追踪', async () => {
  const t = await startApp();
  try {
    const { id, entities } = await seedResume(t);
    const expId = entities.e1.id;

    // both devices load v1
    const before = (await t.j(`/api/resumes/${id}`)).body.entities.find((e) => e.id === expId);
    assert.equal(before.version, 1);

    // device A saves first at expectedVersion=1 -> v2
    const a = await t.j(`/api/resumes/${id}/entities`, { method: 'POST', body: {
      entityId: expId, expectedVersion: 1, fields: { ...before.fields, summary: '设备A修改后的内容' } } });
    assert.equal(a.status, 200);
    assert.equal(a.body.entity.version, 2);
    assert.deepEqual(a.body.changed, ['$:summary']);
    assert.equal(a.body.prevVersion, 1);

    // device B still holds v1 -> conflict, nothing silently overwritten
    const b = await t.j(`/api/resumes/${id}/entities`, { method: 'POST', body: {
      entityId: expId, expectedVersion: 1, fields: { ...before.fields, summary: '设备B迟到的修改' } } });
    assert.equal(b.status, 409);
    assert.equal(b.body.error, 'VERSION_CONFLICT');

    // B refreshes, merges, retries on v2 -> v3
    const current = (await t.j(`/api/resumes/${id}`)).body.entities.find((e) => e.id === expId);
    assert.equal(current.fields.summary, '设备A修改后的内容');
    const b2 = await t.j(`/api/resumes/${id}/entities`, { method: 'POST', body: {
      entityId: expId, expectedVersion: 2,
      fields: { ...current.fields, summary: current.fields.summary + ' + 设备B合并' } } });
    assert.equal(b2.status, 200);
    assert.equal(b2.body.entity.version, 3);
    assert.ok(b2.body.entity.fields.summary.includes('设备A'));
    assert.ok(b2.body.entity.fields.summary.includes('设备B'));

    // shared update is visible in BOTH branches that include the entity
    const full = (await t.j(`/api/resumes/${id}`)).body;
    const onepage = full.branches.find((x) => x.key === 'onepage');
    const detailed = full.branches.find((x) => x.key === 'detailed');
    assert.ok(onepage.items.some((i) => i.id === expId));
    assert.ok(detailed.items.some((i) => i.id === expId));

    // branches may select different entries: remove e2 from onepage only; fact still present & in detailed
    const rm = await t.j(`/api/resumes/${id}/branches/onepage/items`, { method: 'POST', body: {
      entityId: entities.e2.id, kind: 'experience', selected: false } });
    assert.equal(rm.status, 200);
    const after = (await t.j(`/api/resumes/${id}`)).body;
    assert.ok(!after.branches.find((x) => x.key === 'onepage').items.some((i) => i.id === entities.e2.id));
    assert.ok(after.branches.find((x) => x.key === 'detailed').items.some((i) => i.id === entities.e2.id));
    assert.ok(after.entities.some((e) => e.id === entities.e2.id), 'fact itself is never deleted');
  } finally {
    await t.stop();
  }
});
