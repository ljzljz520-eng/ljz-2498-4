/**
 * Deterministic block layout engine. This is the SERVER SOURCE OF TRUTH for height and
 * pagination; the Vue frontend mirrors the algorithm (web/src/lib/layout.js) for instant
 * prediction, and the two are compared in measure responses.
 *
 * Block model produced by templates:
 *  {type:'text', style, text | runs:[{text,bold,italic,family}], keepTogether?:boolean}
 *  {type:'heading', text, style}
 *  {type:'spacer', h}
 *  {type:'rule'}
 *  {type:'item', keepWithNext?:n, blocks:[...]}   // keepWithNext = always keep with next n child blocks
 *
 * Long URLs: break anywhere when they don't fit (break-all for url-like runs), no clipping.
 * Paragraph protection: blocks flagged keepTogether, and keepWithNext groups, never split.
 */
import { coverChar, charWidth } from './fonts.js';

const DEFAULTS = {
  fontSize: 10, lineHeight: 1.35, family: 'Helvetica',
  headingSize: 13, headingGapBefore: 10, headingGapAfter: 4,
  paragraphGap: 5, itemGap: 7, ruleHeight: 8,
};

function looksLikeUrl(s) {
  return /^(https?:\/\/|www\.)\S+/i.test(s) || /\S+\.(com|org|net|io|dev|cn|me|app)([\/?#]\S*)?$/i.test(s);
}

/** Split text into atomic layout chars with resolved fonts and warnings. */
function atomize(text, style, warnings) {
  const atoms = [];
  const styleFamily = style.family;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const cov = coverChar(code, style, warnings);
    atoms.push({
      ch: cov.covered ? ch : '?',
      code: cov.covered ? code : 0x3f,
      font: cov.font, cid: cov.cid,
      w: charWidth(cov.covered ? code : 0x3f, style.fontSize, { family: style.family, bold: style.bold, italic: style.italic }),
      breakable: ch === ' ' || ch === '\t',
      hardBreak: ch === '\n',
      cjk: code >= 0x2e80 && code <= 0x9fff || code >= 0xff00 && code <= 0xffef,
    });
  }
  return atoms;
}

/** Normalize block text/runs into a single atom stream with style changes. */
function blockAtoms(block, warnings) {
  const base = {
    family: block.style?.family || DEFAULTS.family,
    fontSize: block.style?.fontSize || (block.type === 'heading' ? DEFAULTS.headingSize : DEFAULTS.fontSize),
    bold: !!block.style?.bold || block.type === 'heading',
    italic: !!block.style?.italic,
  };
  const segs = [];
  if (block.text != null) segs.push({ text: String(block.text), bold: base.bold, italic: base.italic, family: base.family });
  for (const r of block.runs || []) {
    segs.push({ text: String(r.text), bold: r.bold ?? base.bold, italic: r.italic ?? base.italic, family: r.family || base.family });
  }
  const atoms = [];
  for (const s of segs) {
    const style = { ...base, bold: s.bold, italic: s.italic, family: s.family };
    for (const a of atomize(s.text, style, warnings)) atoms.push(a);
  }
  // break-all for URL segments: mark chars after scheme as anywhere-breakable (except immediately after break)
  return atoms;
}

/** Greedy wrap atoms into lines at target width. CJK allows breaks between any two glyphs. URLs break-all. */
function wrapLines(atoms, widthPx, opts, warnings) {
  const fontSize = opts.fontSize;
  const lines = [];
  let line = [];
  let x = 0;
  // Determine whether the whole text is url-like for break-all behavior.
  const fullText = atoms.map((a) => a.ch).join('');
  const urlMode = opts.breakAll || looksLikeUrl(fullText.trim());

  const push = () => { lines.push(line); line = []; x = 0; };

  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    if (a.hardBreak) { push(); continue; }
    // collapsible leading spaces
    if (a.breakable && line.length === 0) continue;
    if (x + a.w <= widthPx + 0.01) {
      line.push(a); x += a.w;
    } else {
      const prev = line[line.length - 1];
      // Break allowed before this atom if: the previous atom is a space, a CJK glyph
      // (any two CJK glyphs may separate), or we are in break-all URL mode.
      const canBreakHere = line.length > 0 && (prev.breakable || prev.cjk || urlMode);
      if (canBreakHere) {
        push();
        if (a.breakable) continue; // drop the wrapping space
        line.push(a); x = a.w;
      } else if (line.length === 0) {
        // single atom wider than line: force-place (overflow recorded), never clip
        line.push(a); x += a.w;
        warnings.push({ type: 'OVERSIZED_ATOM', ch: a.ch, width: a.w, max: widthPx });
      } else {
        // Unbreakable run (e.g. long latin word) wider than line: force the atom
        // onto a new line rather than dropping or clipping it.
        push();
        line.push(a); x = a.w;
      }
    }
  }
  if (line.length || lines.length === 0) lines.push(line);
  return lines;
}

function lineHeight(block) {
  const size = block.style?.fontSize || (block.type === 'heading' ? DEFAULTS.headingSize : DEFAULTS.fontSize);
  return size * (block.style?.lineHeight || DEFAULTS.lineHeight);
}

/**
 * Flatten template block tree into atomic layout units with keep flags, for measurement/pagination.
 * Returns units: [{h, keepWith:number, block, lines}]  (keepWith => unit must share page with next N units)
 */
function flatten(blocks, warnings, widthPx, inheritedIndent = 0) {
  const units = [];
  for (const block of blocks) {
    if (block.type === 'spacer') { units.push({ h: block.h || DEFAULTS.paragraphGap, keepWith: 0, block }); continue; }
    if (block.type === 'rule') { units.push({ h: DEFAULTS.ruleHeight, keepWith: 0, block }); continue; }
    if (block.type === 'item') {
      // Protect only the LEADING block of an item (e.g. a title line) from being stranded
      // at a page boundary, per the item's keepWithNext hint. Long body paragraphs are
      // still allowed to flow across pages — otherwise every long resume item would be
      // falsely reported as overflow.
      const childBlocks = block.blocks || [];
      const headKeep = Math.min(block.keepWithNext ?? 1, childBlocks.length - 1);
      const annotated = childBlocks.map((cb, i) => i < headKeep
        ? { ...cb, _keepWithNext: Math.max(cb.keepWithNext ?? 0, headKeep - i) }
        : cb);
      const childUnits = flatten(annotated, warnings, widthPx);
      for (let i = 0; i < childUnits.length; i++) {
        // line-level protection only: lead stays with FIRST line of next block;
        // long body paragraphs still flow across pages.
        if (i === 0 && childUnits.length > 1) childUnits[i].keepFirstLineOfNext = true;
      }
      units.push(...childUnits);
      units.push({ h: DEFAULTS.itemGap, keepWith: 0, block: { type: 'spacer', h: DEFAULTS.itemGap } });
      continue;
    }
    // text / heading
    const atoms = blockAtoms(block, warnings);
    const style = {
      fontSize: block.style?.fontSize || (block.type === 'heading' ? DEFAULTS.headingSize : DEFAULTS.fontSize),
      family: block.style?.family || DEFAULTS.family,
      bold: block.style?.bold, italic: block.style?.italic,
      breakAll: block.style?.breakAll,
    };
    const lines = wrapLines(atoms, widthPx, style, warnings);
    const lh = lineHeight(block);
    let h = lines.length * lh;
    if (block.type === 'heading') h += DEFAULTS.headingGapBefore + DEFAULTS.headingGapAfter;
    units.push({
      h, keepWith: block.keepWithNext ?? block._keepWithNext ?? 0,
      block, lines, lh, heading: block.type === 'heading',
    });
  }
  // paragraph protection: a block flagged keepTogether joins itself with following siblings until gap
  for (let i = 0; i < units.length - 1; i++) {
    if (units[i].block.keepTogether) {
      // keep with every consecutive keepTogether/non-spacer run
      let j = i + 1;
      while (j < units.length && units[j].block.type !== 'spacer' && units[j].block.keepTogether) j++;
      if (j < units.length && units[j].block.type !== 'spacer') j++;
      units[i].keepWith = Math.max(units[i].keepWith, Math.min(j - 1 - i, units.length - 1 - i));
    }
  }
  return units;
}

/**
 * Paginate units honoring keepWith. Multi-line text units are expanded into per-line
 * segments so paragraph text can flow across page boundaries (never clipped). A unit's
 * keepWith is carried by its first line and protects that lead line together with the
 * following N atomic units — e.g. an item title kept with its body's first line.
 *
 * Warning:
 *  - GROUP_TALLER_THAN_PAGE: a protected lead group cannot fit on an empty page.
 */
function paginate(units, contentHeight, warnings) {
  // Expand into line segments.
  const segs = [];
  for (const u of units) {
    if (Array.isArray(u.lines) && u.lines.length > 0) {
      u.lines.forEach((line, li) => {
        segs.push({
          h: u.lh, block: u.block, lines: [line], lh: u.lh, heading: u.heading,
          keepWith: li === 0 ? (u.keepWith || 0) : 0,
          keepFirstLineOfNext: li === 0 && u.keepFirstLineOfNext,
          _linesTotal: u.lines.length, _lineIndex: li,
        });
      });
    } else {
      segs.push(u);
    }
  }

  const pages = [[]];
  let used = 0;
  const newPage = () => { pages.push([]); used = 0; };

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    // protect lead line + first line of the following block (widow/orphan control),
    // plus any explicit keepWithLines on the segment.
    let keepLines = s._keepWithLines || 0;
    if (s.keepFirstLineOfNext && i + 1 < segs.length) keepLines = Math.max(keepLines, 1);
    let groupH = s.h;
    for (let k = 1; k <= keepLines && i + k < segs.length; k++) groupH += segs[i + k].h;

    if (used + groupH > contentHeight + 0.01 && used > 0) newPage();
    if (groupH > contentHeight + 0.01) {
      warnings.push({ type: 'GROUP_TALLER_THAN_PAGE', seg: i, needed: groupH, capacity: contentHeight });
    }
    for (let k = 0; k <= keepLines; k++) {
      pages[pages.length - 1].push(segs[i + k]);
      used += segs[i + k].h;
    }
    i += keepLines;
  }

  const totalHeight = pages.reduce((sum, p) => sum + p.reduce((a, s2) => a + s2.h, 0), 0);
  return { pages, pageOf: null, totalHeight };
}

/**
 * Full measure/render.
 * @param {object} page {width,height,margin} in pt
 * @returns {{pages,totalPages,totalHeight,contentHeight,warnings,units}}
 */
export function layoutDocument(blocks, page = {}) {
  const width = page.width || 595;
  const height = page.height || 842;
  const margin = page.margin ?? 48;
  const warnings = [];
  const widthPx = width - margin * 2;
  const contentHeight = height - margin * 2;
  const units = flatten(blocks, warnings, widthPx);
  const { pages, totalHeight } = paginate(units, contentHeight, warnings);
  return {
    page: { width, height, margin, widthPx, contentHeight },
    units, pages, totalPages: pages.length, totalHeight,
    warnings,
    fits: pages.length <= (page.maxPages || 1) && !warnings.some((w) => w.type === 'GROUP_TALLER_THAN_PAGE'),
  };
}

export { DEFAULTS, wrapLines, blockAtoms };
