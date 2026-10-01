/**
 * Client-side pagination PREDICTION, mirroring server/src/render/layout.js.
 * Multi-line text flows across pages; an item title is kept with the first line of its
 * body. `fontBias` simulates browser-vs-server metric drift so the UI can demonstrate
 * the clientDiff warning returned by /measure.
 */
const DEFAULTS = { fontSize: 10, lineHeight: 1.35, headingSize: 13, headingGapBefore: 10, headingGapAfter: 4, itemGap: 7, ruleHeight: 8 };

let CLIENT_FONT_BIAS = 0;
export function setClientFontBias(v) { CLIENT_FONT_BIAS = v; }

function avgWidth(family, bold) {
  if (family === 'Courier') return 0.6;
  if (family === 'Times-Roman') return bold ? 0.509 : 0.49;
  return bold ? 0.606 : 0.6;
}
function atomWidth(ch, size, family, bold) {
  const code = ch.codePointAt(0);
  if (ch === ' ') return size * (family === 'Courier' ? 0.6 : family === 'Times-Roman' ? 0.25 : 0.278);
  if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xff00 && code <= 0xffef)) return size;
  return size * avgWidth(family, bold);
}

function wrap(text, widthPx, { fontSize, family, bold, breakAll }) {
  const isUrl = breakAll || /^(https?:\/\/|www\.)\S+/i.test(text.trim());
  let line = '', x = 0;
  const lines = [];
  const push = () => { lines.push(line); line = ''; x = 0; };
  for (const ch of text) {
    if (ch === '\n') { push(); continue; }
    const w = atomWidth(ch, fontSize, family, bold) * (1 + CLIENT_FONT_BIAS);
    if (x + w <= widthPx) { line += ch; x += w; }
    else {
      const code = ch.codePointAt(0);
      const cjk = code >= 0x2e80 && code <= 0x9fff;
      if (line && (line.endsWith(' ') || cjk || isUrl)) { push(); if (ch === ' ') continue; line = ch; x = w; }
      else { push(); line = ch; x = w; }
    }
  }
  lines.push(line);
  return lines.length ? lines : [''];
}

export function predictLayout(blocks, page = {}) {
  const widthPx = (page.width || 595) - 2 * (page.margin ?? 40);
  const contentHeight = (page.height || 842) - 2 * (page.margin ?? 40);
  const unitHeights = [];
  // line segments with optional keep-with-next-one-line
  const segs = [];
  let total = 0;

  const addText = (b, keepFirstLineOfNext) => {
    const size = b.style?.fontSize || (b.type === 'heading' ? DEFAULTS.headingSize : DEFAULTS.fontSize);
    const lh = size * (b.style?.lineHeight || DEFAULTS.lineHeight);
    const family = b.runs?.length ? (b.runs[0].family || b.style?.family || 'Helvetica') : (b.style?.family || 'Helvetica');
    const text = b.text ?? (b.runs || []).map((r) => r.text).join('');
    const lines = wrap(text, widthPx, { fontSize: size, family, bold: !!b.style?.bold || b.type === 'heading', breakAll: b.style?.breakAll });
    let h = lines.length * lh;
    if (b.type === 'heading') h += DEFAULTS.headingGapBefore + DEFAULTS.headingGapAfter;
    unitHeights.push(Math.round(h * 10) / 10);
    total += h;
    lines.forEach((_, li) => segs.push({ h: lh, keep: li === 0 && keepFirstLineOfNext && lines.length === 1 ? 1 : 0 }));
  };

  const visit = (b, isItemLead) => {
    if (b.type === 'spacer') { const h = b.h || 5; unitHeights.push(h); total += h; segs.push({ h, keep: 0, nonText: true }); return; }
    if (b.type === 'rule') { unitHeights.push(DEFAULTS.ruleHeight); total += DEFAULTS.ruleHeight; segs.push({ h: DEFAULTS.ruleHeight, keep: 0, nonText: true }); return; }
    if (b.type === 'item') {
      const kids = b.blocks || [];
      kids.forEach((kb, i) => visit(kb, i === 0 && kids.length > 1));
      const h = DEFAULTS.itemGap; total += h; segs.push({ h, keep: 0, nonText: true });
      return;
    }
    addText(b, isItemLead);
  };
  blocks.forEach((b) => visit(b, false));

  // paginate lines honoring keep=1 groups
  let pages = 1, used = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const gh = s.h + (s.keep && segs[i + 1] ? segs[i + 1].h : 0);
    if (used + gh > contentHeight && used > 0) { pages += 1; used = 0; }
    used += s.h;
  }

  return { totalHeight: Math.round(total * 10) / 10, totalPages: pages, unitHeights, contentHeight };
}
