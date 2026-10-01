import { fontForCodepoint, FONTS } from "./fonts.ts";
import type {
  BlockMeasure,
  CompiledVariant,
  MeasureResult,
  RenderBlock,
  TextStyle,
} from "./types.ts";

/**
 * Deterministic text layout engine, shared by browser and server.
 *
 * The browser instance is allowed to declare a slightly different profile
 * (font smoothing, subpixel rounding) via `MeasurerOptions`, so we can
 * *compare* the client prediction with the server truth and surface the
 * delta instead of blindly trusting either side.
 */
export interface MeasurerOptions {
  engine: "client" | "server";
  /** free-form profile label recorded into the result and diffs */
  profile: string;
  /** px of rounding/noise the client environment typically introduces */
  jitter?: number;
  /** simulate an environment lacking certain codepoint coverage support? */
  simulateMissingCoverage?: boolean;
  maxPages: number;
}

function styleKey(s: TextStyle): string {
  return `${s.family}:${s.size}:${s.bold ? 1 : 0}`;
}

export function measureRun(
  text: string,
  style: TextStyle,
  opts: { onFallback?: (ch: string) => void; ignoreCoverage?: boolean } = {},
): { width: number; fallback: string[] } {
  let width = 0;
  const fallback: string[] = [];
  for (const ch of text) {
    if (ch === "\n") continue;
    const { font, fellBack } =
      opts.ignoreCoverage
        ? { font: FONTS[style.family], fellBack: false }
        : fontForCodepoint(style.family, ch);
    if (fellBack && !fallback.includes(ch)) {
      fallback.push(ch);
      opts.onFallback?.(ch);
    }
    const adv = font.advances[ch] ?? font.avgAdvance;
    // bold glyphs run slightly wider
    width += adv * style.size * (style.bold ? 1.06 : 1);
  }
  return { width, fallback };
}

interface LaidLine {
  width: number;
}

/** Lay a block out into wrapped lines; explicit \n forces a break. */
export function layoutBlock(
  block: RenderBlock,
  usableWidth: number,
  ignoreCoverage = false,
): { lines: LaidLine[]; height: number; fallback: string[] } {
  const fallback: string[] = [];
  const lines: LaidLine[] = [];
  let lineW = 0;

  const pushLine = () => {
    lines.push({ width: lineW });
    lineW = 0;
  };
  const consumeText = (text: string, style: TextStyle) => {
    const paragraphs = text.split("\n");
    paragraphs.forEach((para, pi) => {
      if (pi > 0) pushLine();
      for (const word of para.split(" ")) {
        const piece = word + " ";
        const { width: w, fallback: fb } = measureRun(piece, style, { ignoreCoverage });
        for (const f of fb) if (!fallback.includes(f)) fallback.push(f);
        // very long unbreakable token (e.g. a long URL) — hard break it
        if (w > usableWidth) {
          const chars = [...piece];
          let segW = 0;
          for (const ch of chars) {
            const { width: cw, fallback: cfb } = measureRun(ch, style, { ignoreCoverage });
            for (const f of cfb) if (!fallback.includes(f)) fallback.push(f);
            if (segW + cw > usableWidth && segW > 0) {
              pushLine();
              segW = 0;
            }
            segW += cw;
            lineW = segW;
          }
          continue;
        }
        if (lineW + w > usableWidth && lineW > 0) {
          pushLine();
          lineW = 0;
        }
        lineW += w;
      }
    });
  };

  for (const run of block.runs) consumeText(run.text, run.style);
  if (lineW > 0 || lines.length === 0) pushLine();

  // line height derives from the block's primary style, per its font
  const { font } = fontForCodepoint(block.style.family, "A");
  const lh = block.style.size * font.lineHeight;
  return { lines, height: lines.length * lh, fallback };
}

export interface Measurer {
  measure(compiled: CompiledVariant): MeasureResult;
  readonly profile: string;
  readonly engine: "client" | "server";
}

export function createMeasurer(opts: MeasurerOptions): Measurer {
  const jitter = opts.jitter ?? 0;
  return {
    profile: opts.profile,
    engine: opts.engine,
    measure(compiled: CompiledVariant): MeasureResult {
      const usableWidth = compiled.page.width - compiled.page.marginLeft - compiled.page.marginRight;
      const usableHeight = compiled.page.height - compiled.page.marginTop - compiled.page.marginBottom;
      const blockMeasures: BlockMeasure[] = [];
      const allFallback = new Set<string>();

      // section header font
      let cursorY = 0;
      let page = 0;
      const sectionHeaderH = 26;
      const overflowBlocks = new Set<string>();

      const ensurePage = () => {
        if (cursorY >= usableHeight) {
          page += 1;
          cursorY = 0;
        }
      };

      for (const section of compiled.sections) {
        ensurePage();
        let sectionH = 0;
        if (section.title) sectionH += sectionHeaderH;

        const laid = section.blocks.map((b) => {
          const { lines, height, fallback } = layoutBlock(b, usableWidth, opts.simulateMissingCoverage);
          fallback.forEach((f) => allFallback.add(f));
          return { b, lines, height };
        });

        // Decide section start page: if the header + whole protected group
        // don't fit, move whole protected group to next page.
        if (section.title) cursorY += sectionHeaderH;

        for (const { b, height } of laid) {
          const total = height + b.spacingAfter + jitter;
          if (b.keepTogether && cursorY + total > usableHeight) {
            if (total <= usableHeight) {
              page += 1;
              cursorY = 0;
            } else {
              // taller than a page even alone — genuinely overflows
              overflowBlocks.add(b.key);
            }
          }
          const startPage = page;
          cursorY += height + b.spacingAfter + jitter;
          let pages = [startPage];
          while (cursorY > usableHeight) {
            page += 1;
            pages.push(page);
            cursorY -= usableHeight;
          }
          blockMeasures.push({
            key: b.key,
            height: height + b.spacingAfter,
            lines: laid.find((x) => x.b === b)!.lines.length,
            pages,
            fallbackGlyphs: laid.find((x) => x.b === b)!.fallback,
            overflow: overflowBlocks.has(b.key),
          });
        }
        cursorY += 0; // section gap added below via next header naturally
      }

      const pageCount = page + 1;
      const totalHeight = blockMeasures.reduce((s, b) => s + b.height, 0);
      const exceeds = pageCount > opts.maxPages || overflowBlocks.size > 0;

      return {
        pageWidth: usableWidth,
        usableHeight,
        pageCount,
        blocks: blockMeasures,
        totalHeight,
        exceeds,
        maxPages: opts.maxPages,
        fallbackGlyphs: [...allFallback],
        engine: opts.engine,
        profile: opts.profile,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Client vs server discrepancy
// ---------------------------------------------------------------------------

export interface MeasureDiscrepancy {
  deltaPages: number;
  clientPages: number;
  serverPages: number;
  /** blocks whose predicted height differs beyond tolerance */
  blockDeltas: { key: string; client: number; server: number; delta: number }[];
  clientFallbackOnly: string[];
  serverFallbackOnly: string[];
  verdict: "match" | "warn" | "conflict";
}

export function diffMeasurements(client: MeasureResult, server: MeasureResult): MeasureDiscrepancy {
  const srv = new Map(server.blocks.map((b) => [b.key, b]));
  const blockDeltas: MeasureDiscrepancy["blockDeltas"] = [];
  for (const cb of client.blocks) {
    const sb = srv.get(cb.key);
    if (!sb) continue;
    const delta = Math.round((sb.height - cb.height) * 10) / 10;
    if (Math.abs(delta) >= 1) blockDeltas.push({ key: cb.key, client: cb.height, server: sb.height, delta });
  }
  const cFb = new Set(client.fallbackGlyphs);
  const sFb = new Set(server.fallbackGlyphs);
  const clientFallbackOnly = [...cFb].filter((g) => !sFb.has(g));
  const serverFallbackOnly = [...sFb].filter((g) => !cFb.has(g));
  const deltaPages = server.pageCount - client.pageCount;
  let verdict: MeasureDiscrepancy["verdict"] = "match";
  if (blockDeltas.length || clientFallbackOnly.length || serverFallbackOnly.length) verdict = "warn";
  if (deltaPages !== 0 || client.exceeds !== server.exceeds) verdict = "conflict";
  return {
    deltaPages,
    clientPages: client.pageCount,
    serverPages: server.pageCount,
    blockDeltas,
    clientFallbackOnly,
    serverFallbackOnly,
    verdict,
  };
}

export { styleKey };
