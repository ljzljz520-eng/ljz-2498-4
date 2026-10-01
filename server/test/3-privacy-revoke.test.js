import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seedResume } from './helpers.js';

test('隐私：分享链接只返回允许内容；撤销手机号后旧链接立即不再含手机号，且响应 JSON 无处藏匿原值', async () => {
  const t = await startApp();
  try {
    const { id } = await seedResume(t);
    // phone allowed for trusted destinations only
    await t.j(`/api/resumes/${id}/privacy`, { method: 'PUT', body: {
      fieldPath: 'profile.phone', purposes: ['internal', 'apply_trusted'] } });

    // create a share link for onepage
    const created = await t.j(`/api/resumes/${id}/shares`, { method: 'POST', body: { branchKey: 'onepage' } });
    assert.equal(created.status, 201);
    const token = created.body.share.token;

    const read1 = await t.j(`/api/shares/${token}`);
    assert.equal(read1.status, 200);
    assert.ok(!('phone' in (read1.body.content.profile || {})), 'phone absent from snapshot content');
    // raw value must not appear anywhere in the JSON payload
    const raw1 = JSON.stringify(read1.body);
    assert.ok(!raw1.includes('138 0000 0000'), 'no raw phone anywhere in response');
    assert.ok(raw1.includes('z@x.com'), 'allowed email still present');

    // even when privacy was initially permissive, revoking removes it from the OLD link:
    // simulate originally-public phone captured in snapshot
    await t.j(`/api/resumes/${id}/privacy`, { method: 'PUT', body: {
      fieldPath: 'profile.phone', purposes: ['internal', 'apply_trusted', 'apply_public', 'share_link'] } });
    const created2 = await t.j(`/api/resumes/${id}/shares`, { method: 'POST', body: { branchKey: 'onepage' } });
    const tok2 = created2.body.share.token;
    const read2 = await t.j(`/api/shares/${tok2}`);
    assert.ok(JSON.stringify(read2.body).includes('138 0000 0000'), 'phone visible while share_link allowed');

    // revoke share_link + apply_public
    await t.j(`/api/resumes/${id}/privacy`, { method: 'PUT', body: {
      fieldPath: 'profile.phone', purposes: ['internal', 'apply_trusted'] } });
    const read3 = await t.j(`/api/shares/${tok2}`);
    assert.equal(read3.status, 200);
    assert.ok(!('phone' in read3.body.content.profile), 'old link now strips phone');
    assert.ok(!JSON.stringify(read3.body).includes('138 0000 0000'), 'raw phone purged from old link JSON');

    // revoke the whole link -> 410
    await t.j(`/api/shares/${tok2}`, { method: 'DELETE' });
    const read4 = await t.j(`/api/shares/${tok2}`);
    assert.equal(read4.status, 410);

    // public export also strips phone; trusted keeps it
    const pub = await t.j(`/api/resumes/${id}/exports`, { method: 'POST', body: { branchKey: 'onepage', purpose: 'apply_public' } });
    assert.ok(pub.body.run.stripped.includes('profile.phone'));
    const trusted = await t.j(`/api/resumes/${id}/exports`, { method: 'POST', body: { branchKey: 'onepage', purpose: 'apply_trusted' } });
    assert.ok(!(trusted.body.run.stripped || []).includes('profile.phone'));
  } finally {
    await t.stop();
  }
});
