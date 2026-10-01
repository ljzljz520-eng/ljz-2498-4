/**
 * Minimal, dependency-free PDF 1.4 writer sufficient for resume output:
 *  - multiple base-14 WinAnsi fonts + one Type0 CID font (STSong-Light/UniGB-UCS2-H)
 *  - positioned text lines, rules; pages from the layout engine
 * Atomic write: bytes are fully built in memory and written via rename of a tmp file;
 * an injected fs can fail to simulate write failure without leaving a partial document.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { CID_FONT } from './fonts.js';

// CP1252 (WinAnsi) encoder for base-14 fonts.
function encodeWinAnsi(str) {
  const out = [];
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code < 0x80) out.push(code);
    else if (code >= 0xa0 && code <= 0xff) out.push(code);
    else {
      const m = WINANSI_80[code];
      if (m != null) out.push(m);
      else out.push(0x3f);
    }
  }
  return Buffer.from(out);
}
const WINANSI_80 = (() => {
  const map = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };
  return map;
})();

// UCS-2 BE encode for UniGB-UCS2-H (2 bytes per BMP code point; surrogate pairs -> ?)
function encodeUCS2(str) {
  const buf = Buffer.alloc(str.length * 2);
  let p = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    buf.writeUInt16BE(code > 0xffff ? 0x003f : code, p); p += 2;
  }
  return buf;
}

function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Render laid-out pages to PDF bytes.
 * @param {object} laid result of layoutDocument
 */
export function renderPdf(laid) {
  const { page, pages } = laid;
  const usedFonts = new Set();
  // discover fonts used by atoms
  for (const u of laid.units) {
    for (const line of u.lines || []) for (const a of line) usedFonts.add(a.font);
  }
  const baseFonts = [...usedFonts].filter((f) => f !== CID_FONT.name);
  const hasCid = usedFonts.has(CID_FONT.name);

  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; }; // 1-based object numbers

  // 1 catalog, 2 pages tree filled later
  const catalogId = add(null);
  const pagesId = add(null);
  const pageIds = pages.map(() => add(null));
  const contentIds = pages.map(() => add(null));

  const fontObjIds = new Map();
  for (const f of baseFonts) fontObjIds.set(f, add(null));
  let cidId = null, cidDescId = null, cidToUnicodeId = null;
  if (hasCid) { cidId = add(null); cidDescId = add(null); cidToUnicodeId = add(null); }

  // font resources used per page
  const buildFonts = () => {
    const entries = [];
    let n = 1;
    for (const f of baseFonts) { entries.push(`/F${n} ${fontObjIds.get(f)} 0 R`); n++; }
    if (hasCid) entries.push(`/FCID ${cidId} 0 R`);
    return `<< ${entries.join(' ')} >>`;
  };
  const fontResourceName = (f) => {
    if (f === CID_FONT.name) return '/FCID';
    const idx = baseFonts.indexOf(f);
    return `/F${idx + 1}`;
  };

  // Stamp resource name (e.g. /F1, /FCID) onto every atom before serializing streams.
  for (const u of laid.units) {
    for (const line of u.lines || []) {
      for (const a of line) a.res = fontResourceName(a.font).slice(1);
    }
  }

  // page contents
  pages.forEach((units, pi) => {
    const stream = buildPageStream(units, page);
    objects[contentIds[pi] - 1] = {
      dict: `<< /Length ${Buffer.byteLength(stream)} >>`,
      stream,
    };
    objects[pageIds[pi] - 1] = {
      dict: `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${page.width} ${page.height}] ` +
        `/Resources << /Font ${buildFonts()} >> /Contents ${contentIds[pi]} 0 R >>`,
    };
  });

  objects[catalogId - 1] = { dict: `<< /Type /Catalog /Pages ${pagesId} 0 R >>` };
  objects[pagesId - 1] = {
    dict: `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
  };
  for (const f of baseFonts) {
    objects[fontObjIds.get(f) - 1] = { dict: `<< /Type /Font /Subtype /Type1 /BaseFont /${f} /Encoding /WinAnsiEncoding >>` };
  }
  if (hasCid) {
    objects[cidId - 1] = {
      dict: `<< /Type /Font /Subtype /Type0 /BaseFont /${CID_FONT.name} /Encoding /${CID_FONT.encoding} ` +
        `/DescendantFonts [${cidDescId} 0 R] /ToUnicode ${cidToUnicodeId} 0 R >>`,
    };
    objects[cidDescId - 1] = {
      dict: `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /${CID_FONT.name} ` +
        `/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>`,
    };
    // Identity-ish ToUnicode: map UCS2 code to same unicode via bfchar ranges is large;
    // provide a cmap covering BMP via beginbfrange in blocks is overkill here — include
    // identity ranges for the CJK blocks used by the document only.
    objects[cidToUnicodeId - 1] = { stream: buildToUnicode(laid) };
  }

  return serialize(objects, catalogId);
}

function buildPageStream(units, page) {
  const top = page.height - page.margin;
  let y = top;
  let parts = [];
  for (const u of units) {
    const b = u.block;
    if (b.type === 'rule') {
      y -= 3;
      parts.push(`0.6 w ${page.margin} ${y.toFixed(2)} m ${page.width - page.margin} ${y.toFixed(2)} l S`);
      y -= (u.h - 3);
      continue;
    }
    if (b.type === 'spacer') { y -= u.h; continue; }
    if (b.type === 'heading') y -= 10; // gap before
    const lh = u.lh;
    for (const line of u.lines || []) {
      y -= lh;
      if (!line.length) continue;
      let x = page.margin;
      // group consecutive atoms with same font resource into one Tj
      let run = null;
      const fs = u.heading ? 13 : (u.block.style?.fontSize || 10);
      const flush = () => {
        if (!run) return;
        const encoded = run.cid ? encodeUCS2(run.text) : encodeWinAnsi(run.text);
        const operand = run.cid ? `<${encoded.toString('hex')}>` : `(${esc(encoded.toString('latin1'))})`;
        parts.push(`BT /${run.res} ${fs} Tf 1 0 0 1 ${run.x0.toFixed(2)} ${y.toFixed(2)} Tm ${operand} Tj ET`);
        run = null;
      };
      for (const a of line) {
        if (!run || run.res !== a.res) {
          flush();
          run = { res: a.res, cid: a.cid, text: '', x0: x };
        }
        run.text += a.ch;
        x += a.w;
      }
      flush();
    }
    if (b.type === 'heading') y -= 4;
  }
  return parts.join('\n');
}


function buildToUnicode(laid) {
  // Collect code points used in CID atoms, emit bfchar pairs (max 100/line chunked).
  const codes = new Set();
  for (const u of laid.units) for (const line of u.lines || []) for (const a of line) {
    if (a.cid && a.code <= 0xffff) codes.add(a.code);
  }
  const sorted = [...codes].sort((x, y) => x - y);
  let s = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /ResumeForgeIdentity def\n/CMapType 2 def\n';
  for (let i = 0; i < sorted.length; i += 100) {
    const chunk = sorted.slice(i, i + 100);
    s += `${chunk.length} beginbfchar\n`;
    for (const code of chunk) {
      const hex = code.toString(16).padStart(4, '0');
      s += `<${hex}> <${hex}>\n`;
    }
    s += 'endbfchar\n';
  }
  s += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
  return s;
}

function serialize(objects, catalogId) {
  let pdf = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    const num = i + 1;
    pdf += `${num} 0 obj\n`;
    if (o.stream !== undefined && o.dict) {
      const body = typeof o.stream === 'string' ? Buffer.from(o.stream, 'latin1') : o.stream;
      pdf += `${o.dict}\nstream\n`;
      pdf += body.toString('latin1');
      pdf += '\nendstream\n';
    } else if (o.stream !== undefined) {
      const body = Buffer.isBuffer(o.stream) ? o.stream : Buffer.from(o.stream, 'latin1');
      const dict = `<< /Length ${body.length} >>`;
      pdf += `${dict}\nstream\n`;
      pdf += body.toString('latin1');
      pdf += '\nendstream\n';
    } else {
      pdf += `${o.dict}\n`;
    }
    pdf += 'endobj\n';
  });
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

/**
 * Atomic write: tmp file in same dir, rename on success. Any failure leaves any previous
 * target file intact and removes the tmp. Returns {path,sha256,byteSize}.
 * @param fsImpl injectable filesystem with writeFile/rename/rm (defaults to node:fs/promises)
 */
export async function writePdfAtomic(targetPath, bytes, fsImpl = fs) {
  const dir = dirname(targetPath);
  const tmp = join(dir, `.${basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fsImpl.writeFile(tmp, bytes);
    await fsImpl.rename(tmp, targetPath);
  } catch (e) {
    await fsImpl.rm?.(tmp, { force: true }).catch(() => {});
    throw e;
  }
  return { path: targetPath, sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length };
}
