/**
 * Font metrics & missing-glyph fallback for the deterministic layout engine.
 *
 * Fonts:
 *  - Base-14 WinAnsi fonts (Helvetica / Times / Courier, incl. bold/italic):
 *    ASCII + a small set of latin punctuation. Anything outside WinAnsi triggers fallback.
 *  - CID font `STSong-Light` with `UniGB-UCS2-H`: standard Asian font referenced without
 *    embedding (Adobe-GB1). CJK characters map here.
 *  - If a character has no font that can cover it, it renders as the notdef marker and a
 *    missing-glyph warning is recorded (fallback chain exhausted).
 */

// Average glyph width in 1000-em units plus italic corrections omitted for determinism.
const AFM = {
  Helvetica: { normal: { avg: 600, space: 278 }, bold: { avg: 606, space: 278 }, italic: { avg: 596, space: 278 }, bolditalic: { avg: 603, space: 278 } },
  'Times-Roman': { normal: { avg: 490, space: 250 }, bold: { avg: 509, space: 250 }, italic: { avg: 479, space: 250 }, bolditalic: { avg: 498, space: 250 } },
  Courier: { normal: { avg: 600, space: 600 }, bold: { avg: 600, space: 600 }, italic: { avg: 600, space: 600 }, bolditalic: { avg: 600, space: 600 } },
};

export const PDF_FONT_ALIASES = {
  Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique', bolditalic: 'Helvetica-BoldOblique' },
  'Times-Roman': { normal: 'Times-Roman', bold: 'Times-Bold', italic: 'Times-Italic', bolditalic: 'Times-BoldItalic' },
  Courier: { normal: 'Courier', bold: 'Courier-Bold', italic: 'Courier-Oblique', bolditalic: 'Courier-BoldOblique' },
};

export const CID_FONT = { name: 'STSong-Light', encoding: 'UniGB-UCS2-H', type: 'Type0' };
export const NOTDEF = '?'; // emitted when every fallback is exhausted

function isCJK(code) {
  // Common CJK ranges covered by Adobe-GB1 / STSong-Light
  return (
    (code >= 0x3000 && code <= 0x303f) ||   // CJK punctuation
    (code >= 0x3400 && code <= 0x4dbf) ||   // ext A
    (code >= 0x4e00 && code <= 0x9fff) ||   // unified
    (code >= 0xff00 && code <= 0xffef) ||   // fullwidth forms
    (code >= 0xf900 && code <= 0xfaff)      // compat
  );
}

// WinAnsi (CP1252) coverage for base-14 fonts.
function winAnsiCovered(code) {
  if (code < 0x80) return true;
  const covered = [
    [0x80, 0x80], [0x82, 0x8c], [0x8e, 0x9c], [0x9e, 0x9f],
    [0xa1, 0xff],
  ];
  return covered.some(([a, b]) => code >= a && code <= b);
}

const variantKey = (bold, italic) => (bold && italic ? 'bolditalic' : bold ? 'bold' : italic ? 'italic' : 'normal');

/**
 * Pick a font resource for a single code point and record fallback warnings.
 * @returns {{font:string, cid:boolean, covered:boolean}}
 */
export function coverChar(code, { family = 'Helvetica', bold = false, italic = false } = {}, warnings) {
  const v = variantKey(bold, italic);
  if (winAnsiCovered(code)) return { font: PDF_FONT_ALIASES[family]?.[v] || 'Helvetica', cid: false, covered: true };
  if (isCJK(code)) {
    warnings?.push({ type: 'FONT_FALLBACK', codePoint: code, char: String.fromCodePoint(code), from: family, to: CID_FONT.name });
    return { font: CID_FONT.name, cid: true, covered: true };
  }
  // Exhausted: emit notdef, keep document valid/readable.
  warnings?.push({ type: 'GLYPH_MISSING', codePoint: code, char: String.fromCodePoint(code), family });
  return { font: PDF_FONT_ALIASES[family]?.[v] || 'Helvetica', cid: false, covered: false, notdef: true };
}

/** Width of a covered code point in text-space units (size * em/1000). */
export function charWidth(code, size, { family = 'Helvetica', bold = false, italic = false } = {}) {
  const v = variantKey(bold, italic);
  if (isCJK(code)) return size * 1.0; // full-width em
  const table = AFM[family] || AFM.Helvetica;
  if (code === 0x20) return size * table[v].space / 1000;
  return size * table[v].avg / 1000;
}

export { winAnsiCovered, isCJK };
