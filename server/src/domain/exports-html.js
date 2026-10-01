import { createHash } from 'node:crypto';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function htmlFromBlocks(blocks, laid, meta) {
  // blocks come from template; laid.units derive from them. Render directly from blocks
  // for HTML view (flow layout handled by browser).
  const renderBlock = (b, depth = 0) => {
    if (b.type === 'heading') return `<h2>${escapeHtml(b.text || '')}</h2>`;
    if (b.type === 'rule') return '<hr/>';
    if (b.type === 'spacer') return '';
    if (b.type === 'item') return `<div class="item">${(b.blocks || []).map((x) => renderBlock(x, depth + 1)).join('')}</div>`;
    const style = [];
    if (b.style?.fontSize) style.push(`font-size:${b.style.fontSize}pt`);
    if (b.style?.family === 'Courier') style.push('font-family:ui-monospace,Menlo,monospace');
    if (b.style?.family === 'Times-Roman') style.push('font-family:Georgia,"Times New Roman",serif');
    let inner;
    if (b.text != null) inner = escapeHtml(b.text).replace(/\n/g, '<br/>');
    else inner = (b.runs || []).map((r) => {
      const tags = [];
      let t = escapeHtml(r.text);
      if (r.bold) { t = `<strong>${t}</strong>`; }
      if (r.italic) { t = `<em>${t}</em>`; }
      if (r.family === 'Courier') t = `<span style="font-family:ui-monospace,Menlo,monospace;font-size:${r.fontSize || 8.5}pt;word-break:break-all">${t}</span>`;
      return t;
    }).join('');
    return `<p style="${style.join(';')}">${inner}</p>`;
  };
  const body = blocks.map((b) => renderBlock(b)).join('\n');
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"/>
<title>Resume export ${escapeHtml(meta.templateKey)}@${escapeHtml(meta.templateVersion)}</title>
<style>body{font-family:Helvetica,Arial,sans-serif;max-width:760px;margin:32px auto;padding:0 24px;color:#111}
h1{font-size:20pt;margin:0 0 4px}h2{font-size:12pt;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #999;margin:16px 0 6px}
p{margin:2px 0;line-height:1.4}.item{margin-bottom:7px}hr{border:none;border-top:1px solid #999;margin:2px 0}
small.meta{color:#777}</style></head>
<body><small class="meta">template ${escapeHtml(meta.templateKey)}@${escapeHtml(meta.templateVersion)} · pages ${laid.totalPages}</small>
${body}</body></html>`;
}

export async function writeHtmlAtomic(targetPath, html, fsImpl = fsp) {
  const tmp = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${process.pid}.tmp`);
  try {
    await fsImpl.writeFile(tmp, html);
    await fsImpl.rename(tmp, targetPath);
  } catch (e) {
    await fsImpl.rm?.(tmp, { force: true }).catch(() => {});
    throw e;
  }
  return { path: targetPath, sha256: createHash('sha256').update(html).digest('hex'), byteSize: Buffer.byteLength(html) };
}
