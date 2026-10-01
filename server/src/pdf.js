import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { FONTS, FALLBACK_FONT, measureRun } from "@cv/shared";

/**
 * Minimal, dependency-free PDF 1.4 writer.
 *
 * The "缺字回退" requirement is implemented explicitly: each codepoint is
 * routed to a font resource that actually covers it. Latin runs use the
 * Base-14 faces matching the template family; CJK codepoints absent from
 * those faces use the standard Type0 CID face (STSong-Light / UniGB-UCS2-H)
 * and every routed glyph is reported back so both UI and tests can see that
 * fallback happened (and where).
 */

export class PdfWriteError extends Error {
  constructor(filePath, cause) {
    super(`PDF write failed for ${filePath}: ${cause}`);
    this.name = "PdfWriteError";
    this.code = "PDF_WRITE_FAILED";
    this.filePath = filePath;
  }
}

const PT = 72 / 96;

// Base-14 faces + one standard CJK CID face
const F_SANS = "F1", F_SANS_B = "F2", F_MONO = "F3", F_MONO_B = "F4";
const F_SERIF = "F5", F_SERIF_B = "F6", F_CJK = "F7";

function pickFont(style, ch) {
  const pref = FONTS[style.family];
  const bold = !!style.bold;
  if (pref.covers.includes(ch)) {
    if (style.family === "mono") return bold ? F_MONO_B : F_MONO;
    if (style.family === "serif") return bold ? F_SERIF_B : F_SERIF;
    return bold ? F_SANS_B : F_SANS;
  }
  // missing in the preferred face -> fallback face, recorded by caller
  if (FALLBACK_FONT.covers.includes(ch)) return F_CJK;
  return F_CJK; // .notdef candidates also go to the CID face
}

// WinAnsi (CP1252) table for the few non-ASCII chars our Latin faces emit
const WIN_ANSI = new Map([
  ["€", 0x80], ["‚", 0x82], ["ƒ", 0x83], ["„", 0x84],
  ["…", 0x85], ["†", 0x86], ["‡", 0x87], ["ˆ", 0x88],
  ["‰", 0x89], ["Š", 0x8a], ["‹", 0x8b], ["Œ", 0x8c],
  ["Ž", 0x8e], ["‘", 0x91], ["’", 0x92], ["“", 0x93],
  ["”", 0x94], ["•", 0x95], ["–", 0x96], ["—", 0x97],
  ["˜", 0x98], ["™", 0x99], ["š", 0x9a], ["›", 0x9b],
  ["œ", 0x9c], ["ž", 0x9e], ["Ÿ", 0x9f], [" ", 0xa0],
]);

function escLatin(ch) {
  const code = ch.charCodeAt(0);
  let byte;
  if (code < 0x80) byte = code;
  else byte = WIN_ANSI.get(ch);
  if (byte === undefined) return null;
  if (ch === "\\" || ch === "(" || ch === ")") return "\\" + ch;
  return String.fromCharCode(byte);
}

function utf16beHex(text) {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code > 0xffff) {
      // surrogate pair
      const v = code - 0x10000;
      const hi = 0xd800 + (v >> 10), lo = 0xdc00 + (v & 0x3ff);
      out += hi.toString(16).padStart(4, "0") + lo.toString(16).padStart(4, "0");
    } else {
      out += code.toString(16).padStart(4, "0");
    }
  }
  return out;
}

/** Flatten block runs into styled atoms, splitting words on spaces/newlines. */
function atomize(block) {
  const atoms = [];
  for (const run of block.runs) {
    for (const ch of run.text) {
      atoms.push({ ch, style: run.style });
    }
  }
  return atoms;
}

function wordWrap(atoms, maxWidthPx) {
  const words = [];
  let cur = [];
  for (const a of atoms) {
    if (a.ch === " " || a.ch === "\n") {
      if (cur.length) { words.push({ atoms: cur, w: widthOf(cur) }); cur = []; }
      words.push({ atoms: [{ ...a }], w: a.ch === " " ? widthOf([a]) : 0, br: a.ch === "\n" });
    } else cur.push(a);
  }
  if (cur.length) words.push({ atoms: cur, w: widthOf(cur) });

  const lines = [[]];
  let x = 0;
  for (const word of words) {
    if (word.br) { lines.push([]); x = 0; continue; }
    if (x + word.w > maxWidthPx && lines[lines.length - 1].length > 0) {
      lines.push([]); x = 0;
    }
    // hard-break a word longer than the whole line (long unbreakable URL)
    if (word.w > maxWidthPx && word.atoms.length > 1) {
      for (const a of word.atoms) {
        const cw = widthOf([a]);
        if (x + cw > maxWidthPx && lines[lines.length - 1].length > 0) {
          lines.push([]); x = 0;
        }
        lines[lines.length - 1].push(a);
        x += cw;
      }
      continue;
    }
    lines[lines.length - 1].push(...word.atoms);
    x += word.w;
  }
  return lines.filter((l) => l.length);
}

function widthOf(atoms) {
  let w = 0;
  for (const a of atoms) {
    const { width } = measureRun(a.ch, a.style);
    w += width;
  }
  return w;
}

/** Group a line's atoms into same-font segments. */
function segmentize(line, onFallback) {
  const segs = [];
  for (const a of line) {
    const font = pickFont(a.style, a.ch);
    if (font === F_CJK && !FONTS[a.style.family].covers.includes(a.ch)) onFallback(a.ch);
    const last = segs[segs.length - 1];
    if (last && last.font === font && last.size === a.style.size) last.text += a.ch;
    else segs.push({ font, size: a.style.size, text: a.ch });
  }
  return segs;
}

function renderSegment(seg) {
  if (seg.font === F_CJK) return `/${seg.font} ${seg.size} Tf <${utf16beHex(seg.text)}> Tj`;
  let out = "";
  for (const ch of seg.text) {
    const e = escLatin(ch);
    if (e === null) {
      // not representable in WinAnsi: route this single char to CID face
      out += `/${F_CJK} ${seg.size} Tf <${utf16beHex(ch)}> Tj /${seg.font} ${seg.size} Tf `;
    } else {
      out += e;
    }
  }
  return `/${seg.font} ${seg.size} Tf (${out}) Tj`;
}

export async function renderPdf(compiled, metrics, outPath, options = {}) {
  const p = compiled.page;
  const pageWPt = p.width * PT, pageHPt = p.height * PT;
  const usableW = p.width - p.marginLeft - p.marginRight;
  const usableH = p.height - p.marginTop - p.marginBottom;
  const fallbackGlyphs = new Set();
  const recordFb = (ch) => fallbackGlyphs.add(ch);

  // Prepare laid blocks with pagination
  const pages = [[]];
  let yTop = 0;
  const newPage = () => { pages.push([]); yTop = 0; };

  const placeLine = (line, lh) => {
    if (yTop + lh > usableH) newPage();
    const segs = segmentize(line, recordFb);
    pages[pages.length - 1].push({
      x: p.marginLeft,
      yPx: p.marginTop + yTop + lh * 0.78, // approx baseline
      segs,
    });
    yTop += lh;
  };

  for (const section of compiled.sections) {
    if (section.title) {
      if (yTop + 26 > usableH) newPage();
      const style = { family: "sans", size: 16, bold: true };
      const lines = wordWrap([...section.title].map((ch) => ({ ch, style })), usableW);
      for (const line of lines) placeLine(line, style.size * 1.35);
    }
    for (const block of section.blocks) {
      const atoms = atomize(block);
      const lines = wordWrap(atoms, usableW);
      const lh = block.style.size * 1.42;
      const blockH = lines.length * lh + block.spacingAfter;
      if (block.keepTogether && yTop + blockH > usableH && blockH <= usableH) newPage();
      for (const line of lines) placeLine(line, lh);
      yTop += block.spacingAfter;
    }
  }

  const contentStreams = pages.map((items) => {
    let s = "";
    for (const it of items) {
      const y = pageHPt - it.yPx * PT;
      s += `BT ${it.segs.map(renderSegment).join(" ")} 1 0 0 1 ${(it.x * PT).toFixed(2)} ${y.toFixed(2)} Tm ET\n`;
    }
    return s;
  });

  const bytes = buildPdf(pageWPt, pageHPt, contentStreams);

  if (outPath) {
    try {
      if (options.simulateWriteFailure) {
        throw new Error("EIO: simulated persistent storage failure");
      }
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, bytes);
      const back = await readFile(outPath);
      if (!isReadablePdfBuffer(back) || back.length !== bytes.length) {
        throw new Error("read-back validation failed (file not readable)");
      }
    } catch (err) {
      throw new PdfWriteError(outPath, err.message);
    }
  }

  return { bytes, fallbackGlyphs: [...fallbackGlyphs], pages: pages.length };
}

/** Structural readability check: header, xref, trailer root, EOF. */
export function isReadablePdfBuffer(buf) {
  const head = buf.subarray(0, 8).toString("latin1");
  if (!head.startsWith("%PDF-")) return false;
  const tail = buf.subarray(Math.max(0, buf.length - 2048)).toString("latin1");
  if (!tail.includes("%%EOF")) return false;
  if (!tail.includes("/Root")) return false;
  // xref table or an object-stream xref must be referenced
  if (!tail.includes("/XRef") && !tail.includes("xref")) return false;
  return true;
}

export async function isReadablePdf(filePath) {
  const buf = await readFile(filePath);
  return isReadablePdfBuffer(buf);
}

function buildPdf(pageWPt, pageHPt, contentStreams) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };

  const catalogId = add(null);
  const pagesId = add(null);
  const fontIds = {
    [F_SANS]: add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    [F_SANS_B]: add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"),
    [F_MONO]: add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>"),
    [F_MONO_B]: add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>"),
    [F_SERIF]: add("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>"),
    [F_SERIF_B]: add("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>"),
  };
  // Standard CJK CID font (STSong-Light, Adobe-GB1)
  const cidFontId = add(
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light " +
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> " +
      "/FontDescriptor << /Type /FontDescriptor /FontName /STSong-Light /Flags 6 " +
      "/FontBBox [ -25 -254 1000 880 ] /ItalicAngle 0 /Ascent 880 /Descent -120 " +
      "/CapHeight 880 /StemV 80 >> >>",
  );
  const cjkFontId = add(
    `<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [ ${cidFontId} 0 R ] >>`,
  );

  const pageIds = [];
  for (const stream of contentStreams) {
    const contentId = add(null);
    const pageId = add(null);
    pageIds.push({ pageId, contentId, stream });
  }

  const pagesKids = pageIds.map((x) => `${x.pageId} 0 R`).join(" ");
  objs[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] =
    `<< /Type /Pages /Kids [ ${pagesKids} ] /Count ${pageIds.length} >>`;

  for (const { pageId, contentId, stream } of pageIds) {
    const buf = Buffer.from(stream, "latin1");
    objs[contentId - 1] =
      `<< /Length ${buf.length} >>\nstream\n` + stream + "endstream";
    objs[pageId - 1] =
      `<< /Type /Page /Parent ${pagesId} 0 R ` +
      `/MediaBox [ 0 0 ${pageWPt.toFixed(2)} ${pageHPt.toFixed(2)} ] ` +
      `/Resources << /Font << /${F_SANS} ${fontIds[F_SANS]} 0 R /${F_SANS_B} ${fontIds[F_SANS_B]} 0 R ` +
      `/${F_MONO} ${fontIds[F_MONO]} 0 R /${F_MONO_B} ${fontIds[F_MONO_B]} 0 R ` +
      `/${F_SERIF} ${fontIds[F_SERIF]} 0 R /${F_SERIF_B} ${fontIds[F_SERIF_B]} 0 R ` +
      `/${F_CJK} ${cjkFontId} 0 R >> >> /Contents ${contentId} 0 R >>`;
  }

  // Serialise with classic xref table
  let pdf = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets = [0];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objs.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i <= objs.length; i++) {
    pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  pdf +=
    `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R >>\n` +
    `startxref\n${xrefStart}\n%%%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}
