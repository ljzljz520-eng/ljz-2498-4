import type { FontFamily, FontSpec } from "./types.ts";

/**
 * Font metrics.  These intentionally approximate real typefaces so the same
 * code can run in the browser (prediction) and in Node (true measurement).
 * `covers` lists the codepoints the font natively contains; when a codepoint
 * is missing the engine must fall back and the missing glyph is reported so
 * the "缺字回退" scenario is observable on both sides.
 */
function buildFont(opts: {
  avg: number;
  wide?: Record<string, number>;
  lineHeight: number;
  covers: string;
}): FontSpec {
  const advances: Record<string, number> = {
    " ": 0.28,
    "!": 0.3,
    '"': 0.4,
    "'": 0.2,
    "(": 0.3,
    ")": 0.3,
    "*": 0.5,
    ",": 0.25,
    "-": 0.33,
    ".": 0.25,
    "/": 0.28,
    ":": 0.28,
    ";": 0.28,
    "?": 0.42,
    "@": 0.9,
    "_": 0.5,
    "—": 0.9,
    "–": 0.7,
    "…": 0.9,
  };
  for (const [ch, w] of Object.entries(opts.wide ?? {})) advances[ch] = w;
  // digits and uppercase/lowercase defaults
  for (let i = 48; i <= 57; i++) advances[String.fromCodePoint(i)] = 0.55;
  for (let i = 65; i <= 90; i++) advances[String.fromCodePoint(i)] = 0.68;
  for (let i = 97; i <= 122; i++) advances[String.fromCodePoint(i)] = 0.52;
  return {
    family: "" as FontFamily,
    avgAdvance: opts.avg,
    advances,
    covers: [...opts.covers],
    lineHeight: opts.lineHeight,
  };
}

const SANS_COVER =
  " ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!\"'()*,-./:;?@_—–…&+#%=<>[]{}|~`^$€";
const SERIF_COVER = SANS_COVER;
// Mono deliberately lacks CJK — forces fallback for Chinese text in URLs/code
const MONO_COVER =
  " ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!\"'()*,-./:;?@_&+#%=<>[]{}|~`^$";

export const FONTS: Record<FontFamily, FontSpec> = {
  sans: { ...buildFont({ avg: 0.52, lineHeight: 1.35, covers: SANS_COVER }), family: "sans" },
  serif: {
    ...buildFont({ avg: 0.48, lineHeight: 1.42, covers: SERIF_COVER }),
    family: "serif",
    // serif lacks the em-dash to demo missing-glyph fallback
    covers: SERIF_COVER.replace("—", "").replace("…", ""),
  },
  mono: {
    ...buildFont({ avg: 0.6, lineHeight: 1.5, covers: MONO_COVER }),
    family: "mono",
  },
};

/** Last-resort fallback font (covers CJK and symbols). */
export const FALLBACK_FONT: FontSpec = {
  ...buildFont({
    avg: 0.95,
    lineHeight: 1.4,
    covers: SANS_COVER + "中文简繁體測試國學號電話手機郵箱聯繫人項目經理資訊科技「」『』、，。：；？！（）《》",
  }),
  family: "sans",
  avgAdvance: 1.0,
};

/** Returns the effective font for one codepoint, or the fallback. */
export function fontForCodepoint(preferred: FontFamily, ch: string): { font: FontSpec; fellBack: boolean } {
  const f = FONTS[preferred];
  if (f.covers.includes(ch)) return { font: f, fellBack: false };
  if (FALLBACK_FONT.covers.includes(ch)) return { font: FALLBACK_FONT, fellBack: true };
  // not even the fallback covers it (e.g. private use) — render .notdef box
  return { font: FALLBACK_FONT, fellBack: true };
}
