import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, seedResume } from './helpers.js';

const failingFs = {
  writeFile: async (p, data) => {
    if (String(p).endsWith('.tmp')) {
      // simulate partial write: some bytes land, then the disk errors out
      fs.writeFileSync(p, Buffer.from(data).subarray(0, 50));
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }
    return fs.promises.writeFile(p, data);
  },
  rename: fs.promises.rename,
  rm: fs.promises.rm,
};

test('PDF 写入失败：目标文件不存在或保持旧版完整，tmp 被清理，导出标记 failed 且可重试', async () => {
  const t = await startApp({ fsImpl: failingFs });
  try {
    const { id } = await seedResume(t, { overflow: false });

    const r1 = await t.j(`/api/resumes/${id}/exports`, { method: 'POST', body: { branchKey: 'onepage', purpose: 'internal' } });
    assert.equal(r1.body.run.state, 'failed');
    assert.equal(r1.body.export.status, 'failed');
    assert.match(r1.body.export.error, /RENDER_OR_WRITE_FAILED/);
    assert.equal(r1.body.export.filePath, null);

    // no .tmp leftovers and no corrupt target
    const leftovers = fs.readdirSync(t.outputDir).filter((f) => f.includes('.tmp'));
    assert.equal(leftovers.length, 0, 'tmp file cleaned up');
    const targets = fs.readdirSync(t.outputDir).filter((f) => f.endsWith('.pdf'));
    assert.equal(targets.length, 0, 'no target file claimed on failure');

    // retry with a healthy fs (new app instance to inject normal fs)
    await t.stop();
    const t2 = await startApp();
    try {
      // re-seed in the new store (memory store is per-process), produce one good file
      const s = await seedResume(t2, { overflow: false });
      const ok1 = await t2.j(`/api/resumes/${s.id}/exports`, { method: 'POST', body: { branchKey: 'onepage', purpose: 'internal' } });
      assert.equal(ok1.body.export.status, 'ok');
      const goodPath = ok1.body.export.filePath;
      const before = fs.readFileSync(goodPath);
      assert.ok(before.subarray(-5).toString().includes('%%EOF'));

      // now emulate a failing re-export writing to the SAME family of path: old file stays
      // (writePdfAtomic renames tmp over target only on full success).
      const { writePdfAtomic } = await import('../src/render/pdf-writer.js');
      await assert.rejects(
        () => writePdfAtomic(goodPath, Buffer.from('%PDF-1.4 broken partial'), failingFs),
        /ENOSPC/,
      );
      const after = fs.readFileSync(goodPath);
      assert.ok(after.equals(before), 'previously approved PDF is byte-identical & still readable');
      assert.equal(fs.readdirSync(path.dirname(goodPath)).filter((f) => f.includes('.tmp')).length, 0);
    } finally {
      await t2.stop();
    }
  } finally {
    // t may already be stopped in retry branch
    try { await t.stop(); } catch {}
  }
});
